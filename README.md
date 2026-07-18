# sol-xhs 🍑

> 太阳哥 × 酱酱 × 小克 — GPT 写稿 → 自动发小红书

## 流程

```
太阳哥 GPT                   GitHub                    酱酱 + 小克
─────────                   ──────                    ────────────
写稿 → push ──────→  drafts/xxx.md  ──→  git pull
                                              ↓
                                        node scripts/publish.mjs
                                              ↓
                                    ┌─ 环境检查（登录/页面）
                                    ├─ 扫描 drafts/ status:ready
                                    ├─ 校验 title/tags/images
                                    ├─ 图片转 base64
                                    ├─ 打印预览 → 人确认
                                    ├─ MCP 发布
                                    ├─ 检查标签（清理平台自动补词条）
                                    ├─ 移到 published/
                                    └─ 记录日志
```

## 目录

| 目录 | 用途 |
|------|------|
| `drafts/` | 待发稿件（status: ready） |
| `published/` | 已发布归档 |
| `assets/` | 配图 |
| `templates/` | GPT 写稿模板 |
| `scripts/` | 发布脚本 |
| `logs/` | 发布日志 |
| `package.json` | Node.js 项目配置 |

## 使用

```bash
# 酱酱拿到新稿后
git pull
node scripts/publish.mjs
```

## Draft 格式

见 [templates/draft-template.md](templates/draft-template.md)
