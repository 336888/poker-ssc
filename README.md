# 飞龙娱乐 · 棋牌与开奖主站

本仓库包含截至 V13 的完整程序目录。下载整个仓库即可取得主站、管理后台、棋牌服务、源码、静态资源和已编译的线上版本。

**[下载完整程序 ZIP](https://github.com/336888/poker-ssc/archive/refs/heads/main.zip)** · [部署说明](DEPLOY.md)

| 目录 | 内容 |
| --- | --- |
| `ssc-ops/web/` | 主站注册登录、大厅、开奖、皇家轮盘、主站后台 |
| `ssc-ops/boot.py`、`ssc-ops/lib/` | 原备份提供的主站启动器及打包的 Python 模块 |
| `poker-online/src/`、`poker-online/server/` | 斗地主、跑得快、联机房间、钱包结算、对账和机器人配置 |
| `poker-online/public/card-table/` | 五人炸金花、牛牛的浏览器端代码及牌型规则 |
| `poker-online/dist/`、`poker-online/dist-server/` | 可部署的棋牌前端与 Node 服务端构建产物 |

生产环境的账户数据、资金流水和密钥由部署方单独保管。
