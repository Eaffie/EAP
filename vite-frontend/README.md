# EAP 前端

EAP 面板的 Web 界面。Vite + React + TypeScript + HeroUI。

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build      # tsc + vite build，产物在 dist/
```

## 目录

```
src/
  api/          接口封装
  components/   通用组件
  config/       站点配置、SNI 预置
  layouts/      管理端 / H5 布局
  pages/        各功能页（仪表板、中转落地、用户、限速…）
  utils/        工具
```
