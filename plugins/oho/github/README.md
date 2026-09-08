# GitHub

读取公开仓库、文件、Issue、Pull Request、提交、分支和 Release。

## 工具

本插件提供 15 个工具的实现和完整清单，其中 15 个读取工具可通过已配置的插件服务调用。

| 操作 | 工具标识 | 当前状态 |
| --- | --- | --- |
| 查看 GitHub 公开仓库 | `github_list_public_repositories` | 连接后可读取 |
| 搜索 GitHub 公开仓库 | `github_search_public_repositories` | 连接后可读取 |
| 读取 GitHub 仓库信息 | `github_read_public_repository` | 连接后可读取 |
| 查看 GitHub 仓库目录 | `github_list_public_repository_contents` | 连接后可读取 |
| 读取 GitHub 仓库文件 | `github_read_public_repository_file` | 连接后可读取 |
| 查看 GitHub Issues | `github_list_issues` | 连接后可读取 |
| 读取 GitHub Issue | `github_read_issue` | 连接后可读取 |
| 查看 GitHub Issue 评论 | `github_list_issue_comments` | 连接后可读取 |
| 查看 GitHub Pull Requests | `github_list_pull_requests` | 连接后可读取 |
| 读取 GitHub Pull Request | `github_read_pull_request` | 连接后可读取 |
| 查看 GitHub PR 文件变更 | `github_list_pull_request_files` | 连接后可读取 |
| 查看 GitHub 提交 | `github_list_commits` | 连接后可读取 |
| 读取 GitHub 提交详情 | `github_read_commit` | 连接后可读取 |
| 查看 GitHub 分支 | `github_list_branches` | 连接后可读取 |
| 查看 GitHub Releases | `github_list_releases` | 连接后可读取 |

## 连接方式

安装后填写插件服务地址和连接密钥。服务需要事先连接你的 GitHub 账号或配置对应密钥；安装插件本身不会完成第三方账号授权。

服务由独立插件仓库运行，启动和凭据配置见[运行说明](https://github.com/wuyuxiangX/oho-plugins/blob/main/docs/runtime.md)。Oho 按仓库版本读取清单，在连接时核对服务提供的工具定义。

仅提供读取操作，不修改第三方数据。
