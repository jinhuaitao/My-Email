# 🚀 Cloudflare Workers 邮箱客户端部署教程
本项目是一个基于 Cloudflare Workers 的无服务器邮件客户端，它利用 Cloudflare Email Routing 接收邮件，并使用 R2 存储服务保存邮件，实现了一个轻量级的网页邮箱。

📦 准备工作
在开始部署之前，您需要具备以下条件：

一个 Cloudflare 账户：已配置 DNS 解析并启用 Email Routing 的域名。

# 步骤一：创建 R2 存储桶和 Workers 服务
1.您需要一个 R2 存储桶来存储邮件和系统配置，以及一个 Worker 服务来运行前端代码和邮件处理逻辑。


2. 创建 R2 存储桶
使用以下命令创建 R2 存储桶。请将 mail-storage-bucket 替换为您希望的存储桶名称。


# R2 存储绑定
[[r2_buckets]]
binding = "MAIL_BUCKET" # 必须与代码中的 env.MAIL_BUCKET 匹配
bucket_name = "mail-storage-bucket" # 替换为你在上一步创建的存储桶名称

# 步骤二：环境变量 (可选，但推荐)
[vars]
# ⚠️ 用于登录页面的 Cloudflare Turnstile 验证码，可选。
# 如果不设置，登录将跳过验证码。
# TURNSTILE_SITE_KEY = "你的 Site Key"
# TURNSTILE_SECRET_KEY = "你的 Secret Key"

# 步骤三：配置 Email Routing 路由到 Worker
现在您需要告诉 Cloudflare 将特定邮箱地址的邮件转发到您刚刚部署的 Worker。

1. 登录 Cloudflare 控制台
进入您的域名管理页面，选择 Email（电子邮件）-> Routes（路由）。

2. 添加 Worker 路由
点击 Create address（创建地址），配置如下：

Custom address（自定义地址）：

地址：填写您在 wrangler.toml 中 [[rules]].pattern 配置的邮箱地址（例如 inbox）。

域名：选择您的域名。

Action（操作）：选择 Send to a Worker（发送到 Worker）。

Worker：在下拉列表中选择您刚刚部署的 Worker 名称（即 cf-webmail-client）。

Save（保存）。

现在，所有发送到 inbox@yourdomain.com 的邮件都会触发您的 Worker 运行 export default { async email(...) } 函数，并将原始邮件存储到 R2 存储桶中。

# 步骤四：访问和初始化
Worker 部署完成后，您可以通过以下步骤首次访问：

1. 访问 Worker URL
在浏览器中打开您的 Worker URL（例如 https://cf-webmail-client.<your-subdomain>.workers.dev/）。

2. 初始化管理员账号
由于是首次访问，Worker 会检测到 R2 中没有配置文件，并自动跳转到初始化页面。

填写您想要的用户名和密码。

点击 完成设置并登录。

设置完成后，系统会跳转到登录页面，您就可以使用刚刚设置的账号登录，开始使用您的无服务器网页邮箱了。

📝 补充说明：Turnstile 验证码
如果您希望在登录页面启用 Cloudflare Turnstile 验证码（防止暴力破解），请执行以下操作：

在 Cloudflare 控制台申请 Turnstile Site Key 和 Secret Key。

将这两个 Key 填写到您 wrangler.toml 文件中的 [vars] 部分（参照步骤一的模板）。

重新部署 Worker (wrangler deploy)。
