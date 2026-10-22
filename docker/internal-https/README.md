# 内网 IP 的 HTTPS 入口

此独立 Compose 项目使用 Caddy，为一个 NAS 私有 IP 签发内网证书并自动续期。只监听指定 IP 的 8443 端口，不占用 NAS 已有的 80/443，不需要域名、DNS 验证或公网入口。后端仍由原有 MindSync 项目管理。

1. 将此目录的配置复制到 NAS 上的独立目录，例如 `/vol1/1000/docker/mindsync-https`。
2. 执行 `docker pull caddy:2-alpine`，用 `docker image inspect caddy:2-alpine --format '{{index .RepoDigests 0}}'` 获取不可变镜像引用。
3. 将 `.env.example` 复制为 `.env`，填写该镜像引用、私有 IP、未占用的 HTTPS 端口及目录属主 UID/GID。创建 `data` 和 `config`，权限设为 `700`，由上述用户拥有。不要更改已有 MindSync 数据目录的属主。
4. 在此目录执行 `docker compose config --quiet`，再执行 `docker compose up -d`。
5. 导出 `data/caddy/pki/authorities/local/root.crt`，在访问设备上安装并信任它。只分发这个公开证书；`data` 中的私钥始终留在 NAS。备份整个 `data` 时必须使用私有备份位置，删除它会生成新的 CA，所有设备需要重新信任。
6. 使用 `curl --cacert root.crt https://<private-ip>:8443/health` 验证完整证书链和 IP，不使用跳过证书验证的方式验收。

浏览器或应用只会在信任该根证书后正常连接。macOS 可将公开根证书导入钥匙串，并在该证书的“信任”中设置 SSL 信任；Windows 可导入当前用户的“受信任的根证书颁发机构”。iOS 安装描述文件后还需开启根证书完全信任。Android 是否接受用户安装的 CA 由应用决定，Obsidian 必须实机验证。此部署不会自动修改设备或 NAS 系统的全局证书信任。

后端迁移到新入口时，将该库 `MINDSYNC_PUBLIC_ORIGIN` 设为实际的 `https://<private-ip>:8443`。`MINDSYNC_TRUSTED_PROXIES` 只填写后端实际看到的代理 TCP 来源 IP；此处经 Docker 的宿主端口转发后通常为应用网络的网关地址，不能直接假定为 `127.0.0.1`。部署时用实际连接核对该地址。代理覆盖 `X-Real-IP`，后端按真实来源限制请求。设备信任和新地址验证完成后再收紧原 HTTP 端口，避免提前中断已有设备同步。
