# Google Calendar

读取日历列表、事件详情和忙闲状态。

## 工具

本插件提供 4 个工具的实现和完整清单，其中 4 个读取工具可通过已配置的插件服务调用。

| 操作 | 工具标识 | 当前状态 |
| --- | --- | --- |
| 查看 Google Calendar 事件 | `google_calendar_list_events` | 连接后可读取 |
| 查看 Google 日历列表 | `google_calendar_list_calendars` | 连接后可读取 |
| 读取 Google 日历事件 | `google_calendar_read_event` | 连接后可读取 |
| 查看 Google 日历忙闲 | `google_calendar_read_freebusy` | 连接后可读取 |

## 连接方式

安装后填写插件服务地址和连接密钥。服务需要事先连接你的 Google Calendar 账号或配置对应密钥；安装插件本身不会完成第三方账号授权。

服务由独立插件仓库运行，启动和凭据配置见[运行说明](https://github.com/wuyuxiangX/oho-plugins/blob/main/docs/runtime.md)。Oho 按仓库版本读取清单，在连接时核对服务提供的工具定义。

仅提供读取操作，不修改第三方数据。
