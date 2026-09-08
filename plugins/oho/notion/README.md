# Notion

搜索并分页读取你明确授权的页面、属性和内容块。

## 工具

本插件提供 4 个工具的实现和完整清单，其中 4 个读取工具可通过已配置的插件服务调用。

| 操作 | 工具标识 | 当前状态 |
| --- | --- | --- |
| 搜索 Notion 页面 | `notion_search_pages` | 连接后可读取 |
| 读取 Notion 页面 | `notion_read_page` | 连接后可读取 |
| 读取 Notion 页面属性 | `notion_read_page_metadata` | 连接后可读取 |
| 查看 Notion 子块 | `notion_list_block_children` | 连接后可读取 |

## 连接方式

安装后填写插件服务地址和连接密钥。服务需要事先连接你的 Notion 账号或配置对应密钥；安装插件本身不会完成第三方账号授权。

服务由独立插件仓库运行，启动和凭据配置见[运行说明](https://github.com/wuyuxiangX/oho-plugins/blob/main/docs/runtime.md)。Oho 按仓库版本读取清单，在连接时核对服务提供的工具定义。

仅提供读取操作，不修改第三方数据。
