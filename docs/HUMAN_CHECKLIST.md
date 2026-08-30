# 开工前人类清单（Codex 干不了的部分）

按优先级排序。⏰ = 10 点开工前必须完成；其余可以并行补。

## ⏰ 开工前

1. **Devpost 注册 + 创建项目页**（webmcp.devpost.com）——注册和提交同一个截止时间 9/3 13:00 PDT，别拖到最后一天。
2. **保持 stable Chrome 152 作为主测试环境**（评委用的就是 stable），开 `chrome://flags/#enable-webmcp-testing` 并重启即可。可选：并排安装 Chrome Beta（153），只用于验证动态注销的增强路径——不要指望它，152 上必须一切正常。
3. **确认 ChatGPT.app 内置浏览器可用**——这是评委的主要测试环境，也是 M0 的硬门槛环境。
4. GitHub：gh 已登录（Caleb0796）✅——决定仓库名（建议 `missiongraph`，public + MIT），M0 后让 Codex push。

## 当天尽早

5. **Vercel 账号**：`pnpm add -g vercel && vercel login`（或用 dashboard）——前端部署（M0 就要）。
6. **Render 账号 + 建一台 VM**——后端 + codex bridge（M3 前就位即可；M0 只需要能起 WS echo，可先用 Render 免费 Web Service 顶替）。
7. **决定 VM 上的 Codex 认证方式（重要）**：
   - 推荐：`OPENAI_API_KEY` + 在 OpenAI 后台设**硬性花费上限**（评委能触发真实 dispatch，必须封顶）；
   - 不推荐：ChatGPT 账号登录——监工 session 会和你本地开发**抢同一个 plan 配额**（今天 10 点你刚等的那个额度）。
8. **Codex 配额策略**：本地开发用你的 ChatGPT plan；开工后避免多余的重型 ultra 会话浪费额度。

## M6 之前（9/2 前搞定）

9. YouTube 账号可上传（<3 分钟公开视频）。
10. 视频旁白：你自己录音（英文或英文字幕），素材由录屏产生。
11. **服务器活到 9/21**：Render VM 和监工 session 要撑过整个评审期，设个日历提醒别让它挂了。
