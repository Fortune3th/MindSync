# 内网域名 HTTPS（阿里云 DNS）

通过 DNS-01 向 Let's Encrypt 申请公开信任的证书，Caddy 自动续期。
只绑定指定的 NAS 内网地址；不需要路由器端口转发。
域名的 A 记录应指向客户端通过内网/VPN 能访问的 NAS 地址。
若 DNS 软件启用了重绑定保护或代理 Fake-IP，需要为该域名配置直连/内网解析。
模板包含一个仅监听 `127.0.0.1:53535` 的证书专用加密 DNS 转发器，避免系统 DNS 拦截破坏 SOA/TXT 验证；不会替换 NAS 的系统 DNS。上游 TLS 校验和证书 DNS 传播检查均保持开启。

1. 构建 `Dockerfile` 中固定版本的 Caddy 和 AliDNS 模块，记录生成的不可变镜像 ID。
2. 复制 `.env.example` 为 `.env` 并填写实际配置，镜像字段使用镜像 ID。
3. 创建仅当前用户可读写的 `alidns.env`（权限 600），填写 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`。使用只拥有目标域名解析权限的专用 RAM 用户。
4. 创建 `data`、`config` 目录，权限 700，所有者与运行 UID/GID 一致。
5. `docker compose config --quiet` 验证后启动；验证证书链、域名、有效期及应用健康，再修改后端 `MINDSYNC_PUBLIC_ORIGIN` 为实际域名地址（包括非默认端口）。
6. 在旧 HTTP 登录页面配置到唯一 HTTPS 地址的跳转。设备 API 是否关闭 HTTP，需要先完成现有设备的地址迁移。

密钥、ACME 账号和证书私钥不得进入 Git、构建上下文或源码发布包。
保留 `data` 以保存 ACME 账号、证书与续期状态；备份必须按私钥保护。
迁移前备份服务环境文件、数据库、库目录和旧代理配置。切换失败时恢复旧镜像、环境文件及代理，避免重新初始化库。

DNS-01 只添加并清理证书验证 TXT 记录。证书域名会记录到公开证书透明度日志。
端口 8443 不影响证书有效性。自动续期需要 NAS 能持续访问阿里云 DNS API、DNS 解析器及 ACME 服务。

参考：[Caddy DNS challenge](https://caddyserver.com/docs/automatic-https#dns-challenge)、[AliDNS 模块](https://github.com/caddy-dns/alidns)。
