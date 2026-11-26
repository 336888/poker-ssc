# V13 部署说明

## 在已有服务器上更新

先结束正在进行的牌局并备份两套数据库、服务配置和环境文件。SQLite 使用 WAL 时应使用 SQLite 备份工具或停服后复制完整数据库文件组。

将仓库的 `poker-online/` 和 `ssc-ops/` 分别覆盖到原部署目录。原备份使用 `/opt/poker-online` 和 `/opt/ssc-ops`。保留服务器现有的环境文件和数据库。更新棋牌服务端和主站模块后重启相应服务，检查日志和页面。

## 运行依赖

- 棋牌服务要求 Node.js 22.13 或更高版本。在 `poker-online/` 下运行 `npm ci --omit=dev` 安装运行依赖，随后运行 `npm start` 启动仓库内的构建产物。
- 重新构建时安装全部依赖，然后执行 `npm run build:online` 和 `npm run build:server`。
- 主站启动器从进程环境读取原部署的 `SSC_SECRET` 以加载 `lib/*.dat`。恢复原系统时请使用与原打包模块兼容的 Python 解释器、原服务依赖和私下保存的环境配置；启动命令为 `python3 boot.py`。启动器本身不加载 .env 文件，应由服务管理器提供环境。
- 棋牌服务需要正确的 `MAIN_API`、与主站匹配的 `POKER_SSO_SECRET`，以及能够写入同一棋牌钱包数据库的 `CARD_WALLET_DB`。默认钱包路径为 `/opt/ssc-ops/ssc_ops.db`。
- 主站使用 `/poker/` 作为棋牌入口，线上前端使用 `/poker/api`。保留已有静态文件、API 与 WebSocket 的反向代理映射。

## 验证

先访问主站和棋牌服务的 `/api/health`。使用隔离测试账户检查验证码、进入牌室、五人匹配、结算以及后台历史记录。原主站的可编辑 Python 模块源码未包含在最初的备份中，仓库保留的是对应的打包模块。

## 上线检查与备份

在主站原服务环境中执行 `python3 boot.py --check` 检查八个打包模块能否用当前密钥和解释器读取。该命令不启动主站。随后启动主站并实际测试登录和接口。

联机部署使用 `NODE_ENV=production` 启动棋牌进程。启动前会检查 SSO 密钥是否配置、钱包数据库是否可获得写锁，以及用户表和流水表的必需字段。容器部署需挂载主站数据库所在的目录（包括 SQLite WAL 文件）并赋予服务用户相应权限。

维护时先暂停新局、等待结算完成，再停止两个服务及其他数据库写入进程。从仓库根目录执行：

```sh
python3 ops/backup.py /opt/ssc-ops/ssc_ops.db /opt/poker-online/data/poker.db /var/backups/poker-ssc
```

脚本逐库生成 SQLite 快照，通过完整性检查后输出备份目录。使用实际 DATA_DIR 替换示例路径。另行保存服务配置和密钥。恢复演练应在隔离目录使用这对快照，检查账户余额、最后一笔流水和房间记录，再启动测试服务。
