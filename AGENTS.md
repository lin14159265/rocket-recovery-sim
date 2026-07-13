# 工程地图

## 项目目标

本项目是“长征十号乙海上网系回收”公开机理下的本地协同控制实验台。它实现可重复的火箭—回收平台—井字网系闭环仿真，用来研究通信时延、状态估计、交会预测、收网控制和接触载荷；它不是官方算法复现，也不是型号数字孪生。

## 目录结构

- `packages/sim-core/`：无 DOM 的确定性仿真内核；物理、传感器、通信、估计、控制、状态机和指标都在这里。
- `apps/web/`：React/Vite 界面；Three.js 场景和 ECharts 曲线只读取仿真快照，不参与控制闭环。
- `scenarios/`：带单位、来源和可信状态的场景参数。
- `tools/`：无界面单场景、Monte Carlo 和 UDP 环回实验入口。
- `docs/`：公开资料边界、系统架构和验证计划。

## 技术栈与入口

- Node.js 22+、npm workspaces、TypeScript。
- React + Vite、React Three Fiber / Three.js、ECharts。
- 核心入口：`packages/sim-core/src/index.ts`。
- Web 入口：`apps/web/src/main.tsx`。

## 常用命令

- 安装：`npm install`
- 开发：`npm run dev`
- 构建：`npm run build`
- 类型检查：`npm run typecheck`
- 测试：`npm test`
- 无界面名义场景：`npm run lab`
- Monte Carlo：`npm run lab:monte-carlo`

## 核心约束

- 控制器不得读取 `TruthState`；数据必须经过传感器和模拟链路。
- 仿真只由整数 tick 驱动；核心不得读取墙上时间或使用 `Math.random()`。
- 消息必须包含源/目的、序号、产生 tick、失效 tick 和 CRC；迟包、重复包和坏包必须显式处理。
- `truth / measurement / estimate / desired / applied` 必须分开记录。
- 接触前使用位置/间距控制，接触后切换到张力/耗能控制。
- 参数必须标明 `official`、`public-estimate`、`assumed` 或 `calibrated`；截图数值不得写成官方参数。
- 高频快照不得进入 React 全局 state；Three/ECharts 使用命令式增量更新。
- 默认最小改动，不做无关重构或批量格式化。

## 关键风险与验证

- 柔性绳和高速接触具有数值刚性，先用等效四绳模型闭环，再升级分段绳模型。
- 任何成功结论至少需要：单元测试、同 seed 确定性测试、步长收敛检查、故障场景和闭环/开环对照。
- 名义场景目标、容差及公开事实边界见 `docs/验证计划.md` 与 `docs/公开资料与模型边界.md`。

