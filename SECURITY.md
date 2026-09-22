# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

请**不要**开公开 issue。走 GitHub 的私密安全公告：

**[Report a vulnerability](https://github.com/hjhjw1991/ai_pantrader/security/advisories/new)**

Please do **not** open a public issue. Use GitHub's private security advisory instead
(link above). I'll acknowledge within a week.

## 这个项目的攻击面 / Threat model

候潮是**本地优先**的：没有服务端、没有账号体系、不上传任何数据。
网页默认只监听 `127.0.0.1:3111`。所以值得关注的主要是这几类：

HouChao is **local-first**: no server, no accounts, nothing uploaded. The web UI listens on
`127.0.0.1:3111` by default. The things worth reporting:

- **本地数据库泄露路径** —— `~/PanTraderData/` 下有你的持仓与交易记录。
  任何让它意外离开本机的代码路径（日志、导出、错误上报）都算。
  *Anything that could move `~/PanTraderData/` off the machine — logs, exports, error reporting.*
- **注入** —— SQL 注入、命令注入，尤其是数据源返回值流进 shell 或 SQL 的地方。
  *Injection, especially where data-source responses reach a shell or SQL.*
- **把网页暴露到局域网/公网的默认配置** —— 界面没有鉴权，因为它假设只有本机能访问。
  *Any default that exposes the UI beyond localhost — there is no auth, by design.*
- **依赖链问题** —— 尤其是原生模块。
  *Supply-chain issues, especially in native modules.*

## 不算漏洞的 / Out of scope

- 你**自己**把 `PORT` 或监听地址改成对外暴露。界面没有鉴权是已知的设计前提，不是缺陷。
  *Deliberately exposing the UI yourself. The absence of auth is a documented assumption.*
- 免费数据源本身的可用性、限频、字段变更。README 已写明它们**非交易级**。
  *Availability or rate limits of the free data sources — documented as not trading-grade.*
- 策略跑出来亏钱。见[免责](README.md#免责)。
  *Losing money. See the disclaimer.*
