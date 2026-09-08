# Slack

读取频道、消息和线程，并在逐次批准后发送纯文本消息。

## 工具

本插件提供 5 个工具的实现和完整清单，其中 4 个读取工具可通过已配置的插件服务调用。

| 操作 | 工具标识 | 当前状态 |
| --- | --- | --- |
| 查看 Slack 频道 | `slack_list_channels` | 连接后可读取 |
| 读取 Slack 频道消息 | `slack_read_channel_messages` | 连接后可读取 |
| 申请发送 Slack 消息 | `slack_propose_message` | 等待审批接入，当前禁止执行 |
| 读取 Slack 频道信息 | `slack_read_channel` | 连接后可读取 |
| 读取 Slack 线程回复 | `slack_read_thread_replies` | 连接后可读取 |

## 连接方式

安装后填写插件服务地址和连接密钥。服务需要事先连接你的 Slack 账号或配置对应密钥；安装插件本身不会完成第三方账号授权。

服务由独立插件仓库运行，启动和凭据配置见[运行说明](https://github.com/wuyuxiangX/oho-plugins/blob/main/docs/runtime.md)。Oho 按仓库版本读取清单，在连接时核对服务提供的工具定义。

修改或发送操作的处理器已经迁移，并保留审批接口。本版本的服务会拒绝这些操作；接入持久化审批和恢复执行后才能使用。
