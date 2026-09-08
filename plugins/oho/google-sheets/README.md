# Google Sheets

读取表格结构和一个或多个明确范围。

## 工具

本插件提供 3 个工具的实现和完整清单，其中 3 个读取工具可通过已配置的插件服务调用。

| 操作 | 工具标识 | 当前状态 |
| --- | --- | --- |
| 读取 Google Sheets 范围 | `google_sheets_read_values` | 连接后可读取 |
| 读取 Google Sheets 信息 | `google_sheets_read_spreadsheet` | 连接后可读取 |
| 批量读取 Google Sheets 范围 | `google_sheets_batch_read_values` | 连接后可读取 |

## 连接方式

安装后填写插件服务地址和连接密钥。服务需要事先连接你的 Google Sheets 账号或配置对应密钥；安装插件本身不会完成第三方账号授权。

服务由独立插件仓库运行，启动和凭据配置见[运行说明](https://github.com/wuyuxiangX/oho-plugins/blob/main/docs/runtime.md)。Oho 按仓库版本读取清单，在连接时核对服务提供的工具定义。

仅提供读取操作，不修改第三方数据。
