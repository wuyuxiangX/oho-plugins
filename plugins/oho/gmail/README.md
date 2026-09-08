# Gmail

搜索和读取邮件与标签、管理草稿，并在逐次批准后发送邮件。

## 工具

本插件提供 7 个工具的实现和完整清单，其中 5 个读取工具可通过已配置的插件服务调用。

| 操作 | 工具标识 | 当前状态 |
| --- | --- | --- |
| 搜索 Gmail | `gmail_search` | 连接后可读取 |
| 读取 Gmail 线程 | `gmail_read_thread` | 连接后可读取 |
| 保存 Gmail 草稿 | `gmail_upsert_draft` | 等待审批接入，当前禁止执行 |
| 申请发送 Gmail | `gmail_propose_send` | 等待审批接入，当前禁止执行 |
| 查看 Gmail 标签 | `gmail_list_labels` | 连接后可读取 |
| 查看 Gmail 草稿 | `gmail_list_drafts` | 连接后可读取 |
| 读取 Gmail 草稿 | `gmail_read_draft` | 连接后可读取 |

## 连接方式

安装后填写插件服务地址和连接密钥。服务需要事先连接你的 Gmail 账号或配置对应密钥；安装插件本身不会完成第三方账号授权。

服务由独立插件仓库运行，启动和凭据配置见[运行说明](https://github.com/wuyuxiangX/oho-plugins/blob/main/docs/runtime.md)。Oho 按仓库版本读取清单，在连接时核对服务提供的工具定义。

修改或发送操作的处理器已经迁移，并保留审批接口。本版本的服务会拒绝这些操作；接入持久化审批和恢复执行后才能使用。
