# MindSync

自己的 NAS 同步服务：TypeScript Obsidian 插件 + Rust/Axum 服务端 + PostgreSQL。飞牛 NAS 通过 Docker Compose 部署，设备保留完整本地库，可离线编辑。面向 macOS、Windows 和 Android；第一版为单用户、单库、多设备。

## 当前交付

支持笔记、附件、版本历史、设备令牌、删除传播、稳定身份的重命名、断线重试和冲突副本。版本冲突保留双方内容；操作 ID 防止重复提交。NAS 保存不可变内容对象，PostgreSQL 保存版本和变更日志，可读 Markdown 文件树由它们重建。

Android 需要 Obsidian 在前台运行；应用关闭或被系统挂起时不承诺后台同步。笔记同步默认排除隐藏目录；0.3.0 新增独立的设置和插件同步，按设备启用并按项选择，收到更新后预览应用。MindSync 自身凭据/日志与 workspace 文件保持本机独立。单文件默认上限 50 MiB，v2 支持内容分块、跨版本去重和未提交候选的断点续传，本地与 NAS 验证结果见验证记录。暂不支持端到端加密、多人协作或 WebDAV。历史对象不自动清理；手动 GC 只回收超过宽限期的无引用对象，保留所有历史版本。可读文件树只供查看和导出，直接修改会在重建时丢弃。

## 网络访问与隐私

插件**只连接一个地址**：你在 MindSync 设置页里自己填写的自建服务地址（`Server` 字段，例如 `https://notes.example.com` 或 `http://192.168.1.10:8080`）。代码中没有任何硬编码的第三方服务地址，唯一出现的 URL 是设置页的输入示例占位符。

默认联网只用于你要求的同步操作：注册设备并获取设备令牌、拉取/推送笔记与附件、查询版本历史与冲突副本、按项同步 Obsidian 设置与插件包、以及查看同步状态。所有请求都带设备令牌发往该地址下的 `/v1/*` 路由，协议见[协议说明](docs/protocol.md)。

- 默认同步部署不使用第三方或中转服务，不发送遥测，不含广告，不自更新，不下载并执行远程代码。可选的服务端邮箱注册与找回会通过你配置的 SMTP 服务发送收件地址和验证邮件，不发送笔记内容。
- 设备令牌、连接设置、状态日志与保留副本只保存在本机的配置目录（`plugins/mindsync/`）内，不参与设置与插件同步。
- 默认同步模式下，笔记、附件与服务端数据都留在自己的 NAS 上。

**Network access（English summary）**：MindSync talks only to the self-hosted server URL entered by the user in its settings, under that server's `/v1/*` routes, using device tokens for sync and a temporary administrator session for device registration. The owner email and password are used only for that administrator sign-in and are not saved by the plugin. Network access is required to register devices and to sync notes, attachments, version history, conflict copies, and the opt-in Obsidian settings/plugin sync. The plugin contains no hardcoded third-party endpoints, no telemetry, no ads, no self-update, and no remotely loaded code. Credentials and state stay in the vault's config directory.

## 部署与安装

客户端源码在仓库根目录（`src/`、`styles.css`、`tests/`），安装包输出到 `dist/plugin/`，安装说明见 [docs/obsidian-install.md](docs/obsidian-install.md)：

| 客户端 | 项目目录 | 安装包 |
| --- | --- | --- |
| Obsidian | 仓库根目录 | `dist/plugin/mindsync-obsidian-0.3.6.zip` |

Obsidian 的 ZIP 解压到资料库插件目录。`dist/plugin/` 放插件包，`dist/source/` 放全项目源码包。

完整步骤见 [飞牛部署说明](docs/deploy-fnos.md)。服务按**库**组织：一个库 = 一个服务端实例 + 一个独立数据目录 + 一个管理令牌。各库独立保存数据。客户端安装与范围见 [docs/obsidian-install.md](docs/obsidian-install.md)。

```sh
sh scripts/ops/add-library.sh obsidian 8080 /vol1/1000/obsidian
```

脚本会提示输入该库的管理令牌与 PostgreSQL 密码（只在你自己的终端里输入，不随机生成、不打印），随后建目录、构建镜像、启动并等待 `/health`。再加一个库：

```sh
sh scripts/ops/add-library.sh research 8081 /vol1/1000/research
```

各库必须使用不同的端口与数据目录，所有库命令都要显式带 `-p`（第一个库的项目名就是 `mindsync`，其余见 `library/<库名>.env` 里的 `MINDSYNC_PROJECT`）。`vault/` 是该库最新的**可读文件树**，可在飞牛文件管理器中直接浏览；它只供查看与导出，直接修改不会同步给设备。

旧的单库方式（`sh scripts/ops/init-env.sh` + `.env` + `docker compose -f docker/compose.yaml up -d --build --wait`）仍然可用，详见部署说明。

将安装包内 `mindsync` 文件夹复制到本地库的 `.obsidian/plugins/`，或库自定义配置目录下的 `plugins/`。它包含 `main.js`、`manifest.json` 和 `styles.css`。在 Obsidian 社区插件设置中启用 MindSync。所有设备首次连接先预览同步计划，再确认合并。

也可以用 BRAT（`jmjFortune/MindSync`）从 GitHub 安装并自动跟随新版本。仓库根目录的 `manifest.json` 是唯一的版本来源，Release 标签与 manifest 版本号一致（形如 `0.3.6`），满足社区目录的安装与更新要求。

## 网页管理

浏览器打开服务地址或 `/admin`，默认显示 **Sign in**，输入 **Email** 和 **Password** 登录。点击 **Create account**，填写邮箱、密码、确认密码，发送并填写邮箱验证码后创建账号。密码为 12–128 位，必须含小写字母、大写字母、数字和特殊字符；规则清单只在设置新密码时显示。登录和注册页面不要求额外的初始化凭据，也不显示 NAS 操作命令。

每个实例只允许一个库主。生产部署通过 `MINDSYNC_OWNER_EMAIL` 指定可注册的库主邮箱，验证该邮箱后创建账号；已有账号不会被注册流程覆盖，已有设备令牌继续可用。

服务端用 Argon2id 保存密码，浏览器使用 HttpOnly 会话 Cookie。退出、重置或修改密码会撤销相应管理会话；密码不写入 URL 或浏览器持久存储。管理页可查看库、注册/重命名/撤销设备、搜索预览和下载历史文件、把文件恢复到某个保留版本，并在 Maintenance 预览和执行无引用对象回收，在 Settings 修改密码。

设备列表显示每个设备的注册时间、最近一次认证请求时间和客户端上报的插件版本；这些字段只反映已记录的请求，不代表设备在线。`Last collection` 显示最近一次实际回收的对象数与字节数，无论它来自管理页还是 `scripts/ops/gc.mjs`。恢复历史版本会提交一个新的最新版本并保留全部更早版本；恢复已删除文件的保留版本会在其原路径把它恢复。回收与恢复都只由管理端执行，没有自动触发器。

点击 **Forgot password?**，通过已绑定邮箱收到的 6 位验证码设置新密码。验证码有效期 10 分钟，最多尝试 5 次，使用后立即失效；重复发送会替换旧码，至少间隔 60 秒，每个邮箱每小时最多 5 次。找回请求统一提示，避免泄露邮箱是否注册。密码重置后所有管理会话失效，设备令牌不受影响；如怀疑设备泄露，在 Devices 单独撤销。

邮件发送需在实例环境文件中配置 `MINDSYNC_SMTP_HOST/PORT/SECURITY/USERNAME/PASSWORD/FROM` 和 `MINDSYNC_PUBLIC_ORIGIN`，详见[认证配置与迁移](docs/email-authentication.md)。邮件可先使用提供商免费额度；短信通常付费，本版未接入短信。服务商账号、凭据、域名验证由部署者配置。

邮箱或服务商不可用时，可在 NAS 项目目录通过终端恢复：

```sh
python3 scripts/ops/reset-admin-password.py
python3 scripts/ops/reset-admin-password.py --library obsidian
```

输入库主邮箱以及两次新密码。脚本通过 stdin 调用运行中服务的数据库恢复入口，在同一事务内修改密码、撤销管理会话和验证码；不会重写环境文件、数据库密码、路径或设备令牌。原 `reset-admin-token.py` 保留为此流程的兼容入口。此入口依赖 NAS 管理员终端权限，没有公开 HTTP 绕过接口。

## 设置和插件同步（0.3.0）

先重载插件，再打开 MindSync → **Settings and plugins → Manage**。每台设备打开 **Sync settings and plugins**，选择 Obsidian 设置、主题、CSS snippets 和需要同步的插件。每个插件的 data.json 设置独立勾选，默认不选；可能包含账号/API keys。Enabled plugin list 也是独立选项，只启用已安装、所选且兼容的插件，并保留本机 MindSync 和未选择插件的启用状态。

来源设备点击 **Publish this device → Publish selected**；其他设备点击 **Review remote settings → Apply selected**。并发差异可选 **Keep local / Use remote**，原内容保存在本机恢复目录。插件文件整组校验与应用，未完成的远端包需等待来源端续传。应用后重载 Obsidian。配置前台每 30 秒检查，收到更新始终等待确认；暂停自动同步后仍可手动操作。第一次发布/接收前不会自动上传。

取消选择、移除本机插件或缺少可选 CSS 不会自动卸载其他设备的插件。workspace、LiveSync 配置、MindSync 的令牌/状态及缓存不参与同步。功能默认关闭，旧设备只同步笔记。NAS `configuration/` 是单独的可读配置投影，备份仍是数据库和不可变 objects。实际 GUI/移动端验收边界见[验证记录](docs/verification.md)。

## 开发

安装并启动 Docker Desktop 和 [Tilt](https://docs.tilt.dev/install.html)，在仓库根目录运行：

```sh
tilt up
```

Tilt 启动本地 Docker 中的 PostgreSQL、Rust/Axum 与 Vite。页面为 [localhost:5173](http://localhost:5173)，Tilt 面板为 [localhost:10350](http://localhost:10350)，Axum 直接入口为 [localhost:18089](http://localhost:18089)。空的本地开发库可直接通过 Create account 注册测试邮箱。测试邮件收件箱为 [localhost:18025](http://localhost:18025)，无需真实邮箱或付费服务。

- 修改页面 CSS 会热更新；HTML/JavaScript 会刷新页面，有效的登录会话可自动恢复。
- 修改 Rust 源码会同步到现有容器，增量编译并重启服务；编译失败时旧服务继续运行。
- 修改依赖清单、Dockerfile 或 Vite 配置会重新构建对应镜像。首次 Rust 编译和依赖下载较慢，后续使用持久化 Cargo 缓存。
- Compose 只定义容器；不运行 `compose watch`，文件监听与同步由 Tilt 负责。

`dev/compose.yaml` 使用独立项目 `mindsync-dev`、命名卷和仅回环地址端口，不加载生产 `.env`，不访问 NAS。开发页面通过 Vite 代理到本地 Axum，生产页面仍嵌入 Rust 二进制，不需要 Node/Vite/Tilt。Ctrl+C 退出 Tilt 后容器仍运行；在仓库根目录运行 `tilt down` 停止并移除开发容器，保留数据和缓存。

以下命令可单独验证插件和服务端：

```sh
npm ci
npm test
npm run build
cargo build --manifest-path server/Cargo.toml --locked
cargo clippy --manifest-path server/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt --manifest-path server/Cargo.toml -- --check
```

服务端集成测试需专用空 PostgreSQL 数据库。测试会建立 schema 并修改测试数据，不能指向生产库：

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/mindsync_test cargo test --manifest-path server/Cargo.toml --locked
```

真实 HTTP 联调使用专用本地服务，会注册设备并创建测试笔记：

```sh
npm exec -- esbuild scripts/check/integration.ts --bundle --platform=node --format=esm --outfile=dist/integration.mjs
# Use a disposable local service and an explicitly issued temporary admin session.
MINDSYNC_ADMIN_SESSION=<temporary-session> node dist/integration.mjs
```

脚本不应加载生产 `.env`；未设置端口时访问 `http://127.0.0.1:18080`。可用 `MINDSYNC_TEST_URL` 指定本地地址。生成插件 ZIP 和不包含凭证、编译缓存的源码包：

```sh
npm run build
node scripts/release/package.mjs
```

## 分块与手动回收

协议 v2 默认 FastCDC 16/64/256 KiB，64 KiB 以下单块。客户端保存不可变候选和清单，恢复后只上传服务器缺失的块；已经提交的操作先从幂等台账确认。单块请求 30 秒超时，最多 3 个块并行，可从命令面板打开 MindSync: View status and conflicts 查看进度。插件仍使用整文件 Vault 读写，单文件默认 50 MiB。

GC 仅供管理端手动触发，默认预览。管理页 Maintenance 先 **Check** 再 **Collect**；命令行按部署说明载入相应库凭据，并设置 `MINDSYNC_URL` 后：

```sh
node scripts/ops/gc.mjs         # 只预览
node scripts/ops/gc.mjs --apply # 删除超过默认 7 天宽限期且没有任何版本引用的对象
```

v2 必须先完成测试与备份，再同步升级服务端和插件。0.2.0 已通过本地与 NAS 隔离验收，现有 NAS Obsidian 库服务已升级；具体证据与硬件验收边界见[验证记录](docs/verification.md)。

## 扩展

[协议](docs/protocol.md)使用文件身份、版本、对象哈希和变更游标，独立于存储位置。服务端内容存储接口预留后续 WebDAV、S3 和网盘实现；仍由 NAS 管理版本一致性。

[设计](docs/designs/2026-10-12-mindsync-design.md)与[验证记录](docs/verification.md)说明约束及已完成的测试。真实飞牛、Windows、Android 实机和外网通道需要进一步验收。实施计划见 [docs/plans](docs/plans)。

各版本的插件行为变化见[更新记录](CHANGELOG.md)；当前插件版本 0.3.6。

## 内网域名 HTTPS

已有阿里云 DNS 域名时，可用 DNS-01 申请浏览器信任的证书并自动续期，NAS 仍只在内网/VPN 可达。无需开放公网 80/443，非默认 HTTPS 端口也可使用。优先使用下方的[组合容器部署](docker/combined/README.md)；需要独立代理时可参考[域名 HTTPS](docker/domain-https/README.md)。没有域名时可继续使用 [内网 IP 证书](docker/internal-https/README.md)，客户端需要信任专用根证书。

## 单个 MindSync 容器部署

可以将应用、HTTPS 和证书专用 DNS 合并为一个 MindSync 容器，PostgreSQL 保持独立。使用原有证书和账号，外部只开放 HTTPS 8080，见[组合容器部署](docker/combined/README.md)。
