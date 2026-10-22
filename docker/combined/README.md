# 单个 MindSync 容器

一个容器内运行 MindSync、Caddy 和证书专用加密 DNS，数据库保持独立。
外部只发布 HTTPS 8080；应用 HTTP 和证书 DNS 仅监听容器内回环地址。
任何一个进程退出都会停止整个容器，由 Docker 的重启策略重新启动；正常停止时向三个进程转发 SIGTERM 并等待退出。

先构建后端和带 AliDNS 模块的 Caddy，再构建组合镜像：

```sh
docker build -t mindsync-backend:local .
docker build -t mindsync-caddy:local docker/domain-https
docker build -f docker/combined/Dockerfile \
  --build-arg MINDSYNC_BACKEND_IMAGE=mindsync-backend:local \
  --build-arg MINDSYNC_CADDY_IMAGE=mindsync-caddy:local \
  -t mindsync:latest .
```

覆盖配置需要 Docker Compose 2.24.4 或更新版本；它清除原来的普通后端构建定义，防止误将组合镜像替换为纯 HTTP 后端。

在库的私有环境文件中设置 `COMPOSE_FILE=docker/compose.yaml:docker/combined/compose.yaml`，使已有管理/备份脚本也会加载覆盖配置。使用已有数据库、数据目录和认证密钥，不重新初始化账号。

还需填写：

- `MINDSYNC_BIND_ADDRESS`：NAS 内网 IP。
- `MINDSYNC_PORT=8080`：宿主机 HTTPS 端口。
- `MINDSYNC_PUBLIC_ORIGIN=https://mindsync.example.com:8080`。
- `MINDSYNC_HTTPS_DOMAIN=mindsync.example.com`。
- `MINDSYNC_DNS_ENV_FILE`：绝对路径，指向包含 AliDNS 密钥的私有环境文件。
- `MINDSYNC_TLS_DATA_DIR`、`MINDSYNC_TLS_CONFIG_DIR`：已有 Caddy 数据/配置目录的绝对路径。

证书数据会挂载到独立于库目录的路径，续期账号、现有证书和私钥会保留。目录所有者必须匹配容器的运行 UID/GID，目录权限 700，密钥文件权限 600。

迁移时先在独立数据库和复制的证书目录上验证启动、HTTPS、异常退出与正常停止。正式切换前暂停应用并备份数据库、库目录和私有配置。完成后删除旧代理/DNS 容器。不要同时启动使用同一库目录的两个应用容器。

`mindsync-entrypoint --recover-owner` 会直接执行原有后端恢复命令，保持运维脚本兼容。TLS 校验、DNS 传播校验、非 root 用户和只读根文件系统保持开启。
