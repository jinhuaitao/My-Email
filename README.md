# CF Webmail · Cloudflare Workers 无服务器邮箱

基于 Cloudflare Workers 的轻量网页邮箱：用 **Email Routing** 收信，原始 `.eml` 存入 **R2**，同一个 Worker 同时负责前端渲染与邮件解析。没有服务器、没有数据库，全部跑在 Cloudflare 免费额度内。

**目录**

- [特性](#特性)
- [架构](#架构)
- [项目结构](#项目结构)
- [部署（Dashboard 连接 GitHub，推荐）](#部署dashboard-连接-github推荐)
- [应用内配置（部署后无需打开控制台）](#应用内配置部署后无需打开控制台)
- [正文翻译（Workers AI）](#正文翻译workers-ai)
- [本地开发](#本地开发)
- [配置参考](#配置参考)
- [安全设计](#安全设计)
- [运维与排查](#运维与排查)
- [成本](#成本)
- [已知取舍](#已知取舍)
- [许可](#许可)

---

## 特性

| 能力 | 说明 |
| --- | --- |
| **一键部署** | `wrangler.jsonc` 里 R2 只写绑定名、不写桶名 → 首次部署时 Cloudflare **自动创建 R2 桶并自动绑定**，无需手工建资源 |
| **免控制台点资源** | R2 / Workers AI 绑定全部由配置文件驱动；只有三个可选变量需要在 Dashboard 填一次 |
| **健壮的 MIME 解析内核** | base64 / quoted-printable、嵌套 multipart、RFC 2047 头部折叠（Header Folding）、GBK 乱码自动嗅探回退 |
| **正文沙箱渲染** | 邮件正文放在**不透明源 iframe** 中并剥离脚本与内联事件，恶意邮件无法触碰你的会话 |
| **附件流式下载** | 附件不进 HTML，按需从 R2 解码返回；10MB 附件也不会把页面撑爆 |
| **完整邮件管理** | 收件箱 / 回收站、批量操作、已读未读、PWA 可安装 |
| **正文一键翻译** | 详情页点「翻译」，正文交给 **Workers AI**（m2m100）译成中文；自动识别源语言，原文译文可随时切换 |
| **应用内配置** | 转发邮箱、Turnstile 密钥全部在网页的「**设置**」页里配，部署后完全不用打开 Cloudflare 控制台 |
| **可选人机验证** | Turnstile **成对配置才启用**，不配置就自动跳过，不会把人锁在门外 |
| **登录防护** | 加盐口令哈希、常量时间比对、按 IP 限流、服务端会话过期 |
| **可观测性** | 开启 `observability` + `upload_source_maps`，日志堆栈可直接映射到源码行号 |

---

## 架构

```
发件人
  │  SMTP
  ▼
Cloudflare Email Routing ──(Send to a Worker)──▶  Worker.email()
                                                      │  原始 .eml
                                                      ▼
                                                 ┌──────────┐
                                                 │    R2    │  env.MAIL_BUCKET
                                                 └──────────┘
                                                      ▲
浏览器 ── HTTPS ──▶ Worker.fetch() ────────────────────┘
                      │
                      ├─ /                        收件箱列表
                      ├─ /email/<key>             邮件详情（正文走 iframe）
                      ├─ /frame/<key>             沙箱化正文文档
                      ├─ /attachment/<key>/<n>    附件流式下载
                      ├─ /trash /delete /restore /purge /batch-action
                      └─ /login /logout /setup /api/check
```

**R2 键名约定**

| 键 | 用途 |
| --- | --- |
| `sys_config.json` | 管理员账号（加盐哈希）、会话 token 与过期时间 |
| `_sys/settings.json` | 应用内设置（转发邮箱、Turnstile 密钥） |
| `<时间戳>_<发件人长度>_<发件人><主题>.eml` | 收件箱邮件（原始 MIME 全文）。**入库时**已把 RFC 2047 编码的头解码为明文；发件人用长度前缀界定，因此发件人里含 `_` 也不会串位 |
| `trash/<原键名>` | 回收站中的邮件 |
| `_sys/login_fail_<ip>` | 登录限流计数（内部键，永不进列表） |

> **历史数据兼容**：老版本用的是 `<时间戳>_<发件人>_<主题>.eml`，且写键名前会把 `?` 等字符清洗成 `_`，
> 导致 RFC 2047 编码词被破坏。新版解析旧键名时会先把编码词按已知结构拼回去再解码
> （`=_UTF-8_Q_xxx_=` → `=?UTF-8?Q?xxx?=`），所以**已入库的老邮件不需要重投就能正常显示**。

---

## 项目结构

| 文件 | 说明 |
| --- | --- |
| `workers.js` | 全部业务代码：前端页面 + 邮件接收 + MIME 解析 + 路由（单文件 Worker） |
| `tests/regression.test.mjs` | **零依赖**回归测试：桩 R2 + 桩 Workers AI + 直接调 `fetch` / `email()`，67 条用例覆盖登录、鉴权、XSS、沙箱、附件、批量操作、正文翻译、设置页、邮件入库与键名还原、历史数据抢救、正文高度回报 |
| `tools/render-preview.mjs` | 把初始化页与登录页渲染成静态 HTML，生成 `.preview/compare.html` 左右对比（`npm run preview`） |
| `tools/verify-frame-height.mjs` | 用无头 Chrome 验证正文 iframe 高度自适应**不会陷入正反馈**（`npm run verify:frame`）。Node 里没有布局引擎，这类布局 bug 只能真跑浏览器才测得出来 |
| `wrangler.jsonc` | 部署配置。**R2 自动创建 + 自动绑定**，并绑定 Workers AI |
| `package.json` / `package-lock.json` | 依赖与脚本，锁文件保证构建可复现 |
| `.dev.vars.example` | 本地开发变量模板（复制为 `.dev.vars`） |
| `.github/workflows/ci.yml` | CI：语法检查 + 回归测试 + 离线校验部署配置 + iframe 高度收敛验证 |
| `LICENSE` | MIT |

---

## 部署（Dashboard 连接 GitHub，推荐）

### 前置条件

1. 一个 Cloudflare 账号，域名已托管在 Cloudflare（DNS 生效）。
2. 该域名已启用 **Email Routing**。
3. **先开通 R2**：Dashboard → **R2** → 点一次同意条款。
   > ⚠️ 这是最关键的一步。账号没开通 R2 时，自动创建桶会直接失败 —— 这是部署失败最常见的原因。
4. 代码已推送到你的 GitHub 仓库。

### 步骤一：创建 Worker 项目

**Workers & Pages** → **Create** → **Workers** → **Connect to Git** → 选择仓库，然后按下表填写：

| 配置项 | 值 |
| --- | --- |
| **Project name** | `cf-webmail-client` ← **必须与 `wrangler.jsonc` 里的 `name` 完全一致** |
| **Build command** | `npm install` |
| **Deploy command** | `npx wrangler deploy` |

点 **Deploy**。首次部署会自动发生两件事：

- **R2 自动创建 + 自动绑定**：`wrangler.jsonc` 里 R2 只有 `"binding": "MAIL_BUCKET"`、没有 `bucket_name`，Cloudflare 会自动建桶（以 Worker 名为前缀命名，具体名称以 Dashboard 为准）并绑定到 `env.MAIL_BUCKET`。**不需要手动建桶，也不需要改代码。**
- **Workers AI 自动绑定**：`"ai": { "binding": "AI" }` 绑定为 `env.AI`，无需创建资源。
  用于**正文翻译**功能（详见 [正文翻译](#正文翻译workes-ai)）。绑定本身不产生费用，只有真正调用模型才按量计费。

> ⚠️ **通过 Dashboard 部署时，自动创建出来的资源 ID 不会写回你的 GitHub 仓库**，只能在 Dashboard 查看。
> 若以后想改用本地 `wrangler deploy`，请先把桶名/ID 从 Dashboard 复制进 `wrangler.jsonc`，
> 否则 wrangler 会当成「没有绑定」再创建一套新资源 —— 你会以为线上邮件全丢了。

### 步骤二：配置变量与密钥（二选一）

**方式 A（推荐）：用网页里的「设置」页**
登录后点侧边栏（或收件箱右上角齿轮）进入 **设置**，填好保存即可，**不需要打开 Cloudflare 控制台**。
详见下一节 [应用内配置](#应用内配置部署后无需打开控制台)。

**方式 B：用 Cloudflare Dashboard 的环境变量**
Dashboard → **Workers & Pages** → `cf-webmail-client` → **Settings** → **Variables and Secrets**：

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `FORWARD_EMAIL` | Text | 否 | 收到邮件后自动转发到这个邮箱；留空 = 不转发 |
| `TURNSTILE_SITE_KEY` | Text | 否 | Turnstile 的 Site Key（公开值） |
| `TURNSTILE_SECRET_KEY` | **Secret** | 否 | Turnstile 的 Secret Key（密钥，必须选 Secret 类型） |

保存后如未生效，到 **Deployments** 点一次 **Retry deployment**。

> **为什么 `wrangler.jsonc` 里没有直接写这三个变量？**
> 因为配置文件里出现过的变量会**覆盖** Dashboard 上的同名变量：写空值或假占位值，
> 等于把你已经配好的真实值清掉（转发失效、验证码永远过不去）。
> 而且 `TURNSTILE_SECRET_KEY` 是密钥，写进仓库等于明文提交到 Git。

### 步骤三：把邮件路由到 Worker

域名管理页 → **Email** → **Email Routing** → **Routes** → **Create address**：

- **Custom address**：如 `inbox`
- **Domain**：你的域名
- **Action**：**Send to a Worker**
- **Worker**：`cf-webmail-client`

保存后，所有发往 `inbox@yourdomain.com` 的邮件都会触发 `export default { async email(...) }`，原始邮件写入 R2。

### 步骤四：首次访问与初始化

1. 打开 Worker URL（`https://cf-webmail-client.<你的子域>.workers.dev/`）。
2. R2 中还没有配置文件，Worker 会自动跳到**初始化页面**。
3. 设置管理员用户名和密码（**密码至少 8 位**），点「完成设置并登录」。
4. 之后用该账号登录即可。

### 部署检查清单

- [ ] 账号已开通 R2（Dashboard → R2 能看到桶列表）
- [ ] 域名已启用 Email Routing
- [ ] Workers 项目的 Project name 与 `wrangler.jsonc` 的 `name` 一致
- [ ] Deploy command 是 `npx wrangler deploy`
- [ ] 首次部署日志里没有 R2 相关报错
- [ ] Email Routing 里已建好指向该 Worker 的地址
- [ ] 已完成管理员初始化并能成功登录

---

## 应用内配置（部署后无需打开控制台）

登录后进入 **设置** 页（侧边栏「设置」，或收件箱右上角的齿轮图标），可以配置：

| 配置项 | 说明 |
| --- | --- |
| **邮件转发** | 邮件存入 R2 成功后自动转发一份；留空 = 不转发。**改完即刻生效** |
| **Turnstile Site Key / Secret Key** | 两个 Key **必须成对填写**，只填一个会直接报错并拒绝保存 |

### 取值优先级

三个配置都按 **应用内设置 → 环境变量 → 关闭** 三段式回退：

```
应用内设置（R2）──有值──▶ 生效
      │
      └──无值──▶ Dashboard 环境变量 ──有值──▶ 生效
                        │
                        └──无值──▶ 关闭（例如验证码自动跳过）
```

所以**已经用环境变量配好的老部署不会因为这次升级而失效**；而设置页里的值会覆盖环境变量。
设置页右上角的徽章会明确标出当前生效来源（`应用内已配置` / `来自环境变量` / `未配置`）。

### 几个设计细节

- **Secret Key 永不回显**：页面只显示掩码（如 `SUPERS••••••••1234`）。
  因此该输入框**留空 = 保持原值不变**；想清空请用页面底部的「清空 Turnstile 密钥」（需点两次确认）。
  非密钥字段（转发邮箱、Site Key）会回显当前值，所以**留空 = 清空**。
- **成对校验**：Site Key 与 Secret Key 只填一个会返回 `400` 并拒绝保存，避免「以为配好了、实际永远过不去」。
- **不会把人锁死**：两个 Key 不完整时验证直接关闭，登录页也不渲染组件。
- **生效时机**：Site Key 是服务端渲染进登录页的，保存后**下次打开登录页**生效。
- **存储位置与取舍**：配置存在 R2 的 `_sys/settings.json`。
  Cloudflare 的**环境变量 Secret 是加密存储**的，而 **R2 的值不是** ——
  放进 R2 换来「免控制台配置」，代价是失去静态加密。
  如果你更看重加密存储，就继续用方式 B（环境变量）；设置页清空密钥后会自动回退到环境变量。

> 本项目是单管理员应用，登录后即是管理员，因此设置页没有额外的权限层。
> 若你要改成多用户，记得给 `/settings` 加一道管理员校验。

---

## 正文翻译（Workers AI）

邮件详情页右上角的「**翻译**」按钮会把正文译成中文，再点一下切回原文。

**实现要点**

| 项 | 说明 |
| --- | --- |
| 模型 | `@cf/meta/m2m100-1.2b` —— 多对多翻译模型，**只做翻译、不生成新内容**，不会像对话模型那样擅自总结或加料 |
| 接口 | `env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang, target_lang })` → `{ translated_text }` |
| 支持语种 | 英 / 中 / 法 / 西 / 阿拉伯 / 俄 / 德 / 日 / 葡 / 印地语（模型固定支持这 10 种） |
| 源语言识别 | **必须显式传 `source_lang`**，因为模型默认 `english`。代码按字符集（汉字/假名/谚文/西里尔/阿拉伯/天城文）+ 拉丁语系高频虚词做一次轻量识别 |
| 长邮件 | 按段落切成最多 6 段（每段 2500 字）**并行**翻译再拼接；超出部分标记为「已截断」并提示 |
| 输入来源 | 优先用 `text/plain` 部分；只有 HTML 的邮件会先剥标签、解实体、去 script 再翻译 |

**几种情况会明确告诉你原因，而不是硬翻出一堆乱码：**

- 邮件本来就是中文 → 「这封邮件本来就是中文，无需翻译」
- 语种不在支持列表（如韩文）→ 「翻译模型暂不支持该语言」
- 没绑定 Workers AI → 提示去检查 `wrangler.jsonc` 的 `ai` 绑定
- 模型调用失败 → 「翻译失败，请稍后重试」（堆栈只进日志，不回显）

**成本与隐私**

- 计费：$0.342 / 百万输入 token + $0.342 / 百万输出 token，**只在你点「翻译」时产生**。
  Workers 免费版每天有 10,000 Neurons 额度，个人收发邮件的翻译量通常远低于此。
- 隐私：译文由 Cloudflare 的 Workers AI 推理，**跑在你自己账号的基础设施内**，不经第三方。
  若你完全不希望正文离开 Cloudflare，把 `wrangler.jsonc` 里的 `ai` 绑定删掉即可 ——
  翻译按钮会给出「未绑定 Workers AI」的提示，其余功能不受影响。

---

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入本地测试用的变量
npm run dev                      # 本地跑，自动创建本地 R2（存在 .wrangler/，不影响线上）
```

其他脚本：

| 命令 | 作用 |
| --- | --- |
| `npm test` | 跑回归测试（**零依赖、不联网、不碰线上数据**） |
| `npm run preview` | 渲染初始化页 / 登录页到 `.preview/compare.html`，左右对比视觉效果 |
| `npm run verify:frame` | 用无头 Chrome 验证正文 iframe 高度自适应会收敛（需要本机有 Chrome / Edge / Chromium，没有则自动跳过） |
| `npm run check` | **离线**校验部署配置（不需要登录、不需要账号） |
| `npm run deploy` | 本地 CLI 部署（会把你创建的资源 ID 写回配置） |
| `npm run tail` | 实时查看线上日志 |
| `npm run types` | 生成 `worker-configuration.d.ts`，让编辑器识别 `env` 上的绑定 |

`npm run check` 的正常输出：

```
Your Worker has access to the following bindings:
Binding                 Resource
env.MAIL_BUCKET         R2 Bucket
env.AI                  AI
```

---

## 配置参考

### 绑定

| 绑定 | 类型 | 来源 | 代码中的用法 |
| --- | --- | --- | --- |
| `MAIL_BUCKET` | R2 桶 | `wrangler.jsonc` 自动创建 | `env.MAIL_BUCKET` |
| `AI` | Workers AI | `wrangler.jsonc` 自动绑定 | `env.AI`（用于正文翻译） |

### 变量

| 变量 | 类型 | 默认行为 | 代码中的用法 |
| --- | --- | --- | --- |
| `FORWARD_EMAIL` | 文本 | 未设置 → 不转发 | 存库成功后调用 `message.forward()` |
| `TURNSTILE_SITE_KEY` | 文本 | 未设置 → 登录页不渲染验证码 | 注入登录页 `data-sitekey` |
| `TURNSTILE_SECRET_KEY` | 密钥 | 未设置 → 跳过服务端校验 | 调 Turnstile `siteverify` |

**只有两个 Turnstile 变量同时存在时验证才会启用**（`siteKey && secretKey`）。
只填一个属于半配置：服务端会直接跳过校验，登录页也不渲染组件 —— 不会把人锁死。

每个配置的取值都按 **应用内设置 → 环境变量 → 关闭** 三段式回退，详见 [应用内配置](#应用内配置部署后无需打开控制台)。

---

## 安全设计

| 风险 | 处理方式 |
| --- | --- |
| **邮件内容 XSS** | 主题、发件人、附件名等完全由发件人控制，渲染前统一 `escapeHtml()` |
| **点击行 XSS** | 不再把键名拼进 `onclick` 字符串（`encodeURIComponent` **不转义单引号**），改为 `data-key` + 事件委托 |
| **正文脚本执行** | 正文在不透明源 iframe 中渲染（`sandbox` 属性 + CSP `sandbox`），并额外剥离 `<script>` 与内联 `on*` 事件 |
| **附件类型混淆** | `text/html` / `image/svg+xml` 等危险 MIME 一律降级为 `application/octet-stream` + `Content-Disposition: attachment` |
| **口令存储** | 加盐 SHA-256（每账号 16 字节随机盐），并兼容早期无盐数据 |
| **口令比对** | 常量时间 `safeEqual`，避免逐字符提前返回泄漏前缀信息 |
| **暴力破解** | 按 `CF-Connecting-IP` 限流：15 分钟窗口内失败 8 次 → 锁定 10 分钟（**锁定期间即使口令正确也拒绝**） |
| **会话** | 32 字节随机 token、`HttpOnly` + `Secure` + `SameSite=Lax`、服务端校验 30 天过期 |
| **信息泄漏** | 未捕获异常只写日志，不把堆栈回显给客户端；页面统一 `no-store` + `noindex` |
| **搜索引擎收录** | 全站 `X-Robots-Tag: noindex`，并提供 `robots.txt` 拒绝抓取 |
| **点击劫持** | 页面响应带 `X-Frame-Options: DENY`（正文 iframe 单独用 `SAMEORIGIN`） |
| **开放重定向** | 批量操作的回跳目标由表单 `next` 字段给出，并**白名单校验**（只接受 `/` 与 `/trash`），不接受任意 URL |
| **脚本块注入** | 键名会内联进详情页的 `<script>`，因此统一经 `jsonForScript()` 转义 `<` `>` `&` 与行分隔符，防止邮件主题里的 `</script>` 提前闭合脚本块 |
| **译文注入** | 译文用 `textContent` 写入，不做 HTML 解析；翻译输入只取纯文本，HTML 邮件的标签与 script 在送模型前已被剥离 |
| **正文高度回报** | 子页面只回报**内容容器**的高度，父页面**原样采用**（不加固定增量）。iframe 高度会决定它内部视口的高度，而 `documentElement.scrollHeight` 被视口高度托底 —— 两者一旦互相喂大就是无限空白（详见「运维与排查」） |

> **重定向约定**：`Response.redirect()` 只接受**绝对 URL**，传相对路径会抛 `TypeError`。
> 因此全站统一写成 `Response.redirect(url.origin + '/xxx', 302)`，并在测试里加了静态断言防止回归。
> 另外不要把 `Referer` 当回跳依据 —— 本站带 `Referrer-Policy: no-referrer`，浏览器根本不会发它。

---

## 运维与排查

| 症状 | 原因与处理 |
| --- | --- |
| 部署失败，日志提示 R2 相关错误 | 账号还没开通 R2。Dashboard → R2 点一次同意条款后重新部署 |
| 改了 Dashboard 变量没生效 | 到 Deployments 点一次 **Retry deployment** |
| 登录页报「尝试次数过多」 | 触发了 IP 限流。等待 10 分钟，或删除 R2 中的 `_sys/login_fail_<你的IP>` 键 |
| Turnstile 一直不过 | 两个 Key 必须来自同一个 Turnstile 站点且成对配置。想临时关闭：删掉两个变量后重新部署 |
| 中文邮件乱码 | 解析内核已内置 GBK 回退：UTF-8 解出替换字符（�）时自动改用 GBK 重解，并择错误更少的结果 |
| 列表里主题显示成 `= UTF-8 Q =F0=9F=90=9D` 这类怪东西 | 是**修复前已入库**的旧邮件。老版本写键名前做了一遍文件名清洗，把 RFC 2047 里的 `?` 换成了 `_`（`=?UTF-8?Q?xxx?=` → `=_UTF-8_Q_xxx_=`），编码标记被破坏。**新版会自动抢救**：解析旧键名时先按已知结构把编码词拼回去再解码，无需重新投递。新到的邮件则在入库时就已解码，不会再产生这个问题 |
| 点邮件行没反应、打不开 | 老版本的点击守卫用 `closest('form')` 排除交互控件，但邮件行本身就在 `<form id="batch-form">` 里，于是整行点击被吞。已改为先把目标归到 `.email-row`，再排除 `a/button/input/label/select/textarea/iframe` |
| 打开邮件后正文下方**无限空白** | 正文 iframe 高度自适应陷入了**正反馈**。两个错误叠加：① 子页面测的是 `documentElement.scrollHeight`，而这个值**被视口高度托底**（内容再短也返回不小于视口的值）；② 父页面又把测得值 `+8px` 设为 iframe 高度。于是「视口变高 → 测得更高 → iframe 再变高」，实测 4 秒能从 394px 涨到 2138px，最终顶到上限。**已修复**：改测内容容器 `#mail-root`（与视口无关）、父页面原样采用不加增量，并对「等幅匀速爬升」加熔断（兜住正文自带 `min-height:100vh` 这类 vh 内容）。`npm run verify:frame` 可复验 |
| 点批量操作（已读 / 未读 / 删除）报「服务暂时不可用」 | 老版本用 `Response.redirect(request.headers.get('Referer') \|\| '/')` 回跳。但本站响应带 `Referrer-Policy: no-referrer`，浏览器**永远不发** Referer；而 `Response.redirect()` 只接受**绝对 URL**，拿到 `'/'` 会直接抛 `TypeError: Failed to parse URL from /` → 500。已改为由表单自带 `next` 字段 + 白名单校验，并用绝对 URL 重定向 |
| 点「翻译」提示「未绑定 Workers AI」 | `wrangler.jsonc` 里的 `"ai": { "binding": "AI" }` 没生效。确认该行存在且未被注释，然后重新部署 |
| 点「翻译」提示「暂不支持该语言」 | m2m100 固定只支持 10 种语言（英/中/法/西/阿拉伯/俄/德/日/葡/印地语），韩文等不在其中。这是模型能力边界，不是 bug |
| 翻译结果明显不对 | 多半是源语言识别错了（模型默认按英文处理）。`detectSourceLang()` 是轻量启发式，判不出时会退回英文 |
| 长邮件只翻译了一部分 | 单封最多翻 6 段 × 2500 字，超出部分会截断并在状态条上提示 |
| 邮件正文被当成附件 | 极少数畸形邮件。解析器有「绝望模式」容错，会把疑似正文的附件内容强行显示出来 |
| 忘记管理员密码 | 删除 R2 中的 `sys_config.json`，重新访问站点即回到初始化页面（**注意：会一并清掉会话**） |
| 想改成单文件版本 | 把 `workers.js` 改名为 `_worker.js` 放进 Cloudflare Pages 的静态目录即可 |

查看线上日志：Dashboard → 你的 Worker → **Logs**，或本地 `npm run tail`。

---

## 成本

全部在 Cloudflare 免费额度内：

- **Workers**：免费版每天 10 万次请求
- **Email Routing**：接收邮件免费，不限量
- **R2**：10 GB 存储 + 每月 100 万次 A 类操作免费，且**出网流量免费**
- **Workers AI**：绑定本身免费，只有点「翻译」时按量计费（$0.342/百万 token 输入输出同价）。
  免费版每天 10,000 Neurons 额度，个人用量通常远低于此

---

## 已知取舍

- **Tailwind 走 CDN**：页面引用 `https://cdn.tailwindcss.com`，省掉了构建步骤，代价是首屏多一个外部请求。若追求极致性能，可改用 Tailwind CLI 在构建阶段产出 CSS，再改走静态路由。
- **变量既支持应用内设置也支持环境变量**：设置页换来「免控制台配置」，代价是密钥存在 R2 里、失去 Cloudflare 的静态加密；如果你更看重加密存储，用环境变量即可，两者按「设置 → 环境变量」回退。
- **邮件保存在 R2 而非数据库**：列表页靠键名解析出发件人与主题。发件人用**长度前缀**界定，含 `_` 也不会串位；主题保留发件人之后的全部内容，因此含 `_` 也完整。极端情况（主题里出现与分隔语义冲突的字符）只影响列表显示，正文与附件不受影响。
- **旧邮件主题里的 `_` 会被显示成空格**：这是历史数据的固有损失 —— 老版本把 `?` `"` `<` `>` 等字符统一清洗成了 `_`，落盘后无法区分「原来是 `?`」还是「原来就是 `_`」。抢救逻辑能还原 RFC 2047 编码词（绝大多数乱码都是这一类），但还原不了这个歧义；且只影响列表页文字。
- **翻译只翻正文，不翻主题，也不保留排版**：主题通常很短、一眼能看懂，翻它反而让列表页变味。译文是纯文本段落，链接和图片仍以原文为准 —— 想看版式就点「显示原文」。
- **翻译用专用翻译模型而非对话大模型**：`m2m100` 只做翻译、不会擅自总结或加料，但只支持 10 种语言，且需要显式告诉它源语言。换成 LLM 可以覆盖更多语种，代价是可能改写原意。
- **初始化页与登录页共用同一套视觉**：相同的背景渐变、玻璃卡片、logo 块与页脚，避免首次部署与日常登录看起来像两个产品。
- **正文 iframe 允许脚本**：为了让注入的「高度自适应」脚本生效。由于沙箱是不透明源，邮件自带脚本拿不到本站 Cookie / DOM / localStorage，风险已被隔离。若你更保守，可把 iframe 的 `sandbox` 与 CSP 中的 `allow-scripts` 去掉，代价是正文高度固定为 `60vh`。

---

## 许可

[MIT](LICENSE)
