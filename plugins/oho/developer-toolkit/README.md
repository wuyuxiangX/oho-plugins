# Developer Toolkit

这是一个独立于 Oho 主仓的本地开发插件，用来验证 Oho Plugin API v2 的完整链路。

它提供两个只读 Tool、一个按需加载的 Skill 和一个聊天 Command。插件没有网络权限，也不需要账号或密钥。

```bash
pnpm install --ignore-scripts
pnpm check
pnpm build
oho plugin dev .
```

`dist/index.js` 是当前可运行的独立构建产物，不依赖 Oho 应用仓库。
