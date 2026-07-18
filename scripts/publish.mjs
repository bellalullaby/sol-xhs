#!/usr/bin/env node
// ============================================
// sol-xhs 发布脚本 v1.0
// 用法: node scripts/publish.mjs
// ============================================

import { readFile, readdir, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import https from 'node:https';
import { Buffer } from 'node:buffer';

// ============================================
// 配置
// ============================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRAFTS = join(ROOT, 'drafts');
const PUBLISHED = join(ROOT, 'published');
const LOGS = join(ROOT, 'logs');
const API_KEY = process.env.SOL_XHS_API_KEY;
if (!API_KEY) {
  console.error('❌ 请设置环境变量 SOL_XHS_API_KEY（从 aredink.com 获取）');
  process.exit(1);
}
const MCP_URL = 'https://mcp.aredink.com/mcp';

const CHECKLIST_URL = 'https://creator.xiaohongshu.com/publish/notes';
const CHECKLIST = [
  'Chrome 打开创作中心发布页（能看到「上传图文」tab）',
  `URL: ${CHECKLIST_URL}`,
  '小红书已登录',
];

// ============================================
// 工具函数
// ============================================

function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function log(msg) {
  const ts = timestamp();
  console.log(`[${ts}] ${msg}`);
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ============================================
// 步骤 0: 环境检查
// ============================================

async function checkEnvironment() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 发布前环境检查');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  for (const item of CHECKLIST) {
    console.log(`  ☐ ${item}`);
  }
  console.log('');
  const ans = await ask('以上全部就绪？(yes/no): ');
  if (ans.toLowerCase() !== 'yes' && ans.toLowerCase() !== 'y') {
    console.log('👋 已取消。请打开发布页后重试。');
    process.exit(0);
  }
  log('环境检查通过 ✅');
}

// ============================================
// 步骤 1: 解析 frontmatter
// ============================================

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('未找到有效 frontmatter（--- 包裹的元数据）');

  const frontmatter = {};
  const lines = match[1].split('\n');
  let currentKey = '';
  let inArray = false;
  let arrayValues = [];

  for (const line of lines) {
    if (inArray) {
      const arrMatch = line.match(/^\s*-\s+(.+)$/);
      if (arrMatch) {
        arrayValues.push(arrMatch[1].trim());
        continue;
      } else {
        frontmatter[currentKey] = arrayValues;
        inArray = false;
        arrayValues = [];
      }
    }

    if (line.trim() === '') continue;

    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    if (value === '') {
      currentKey = key;
      inArray = true;
      arrayValues = [];
    } else if (value.startsWith('"') && value.endsWith('"')) {
      frontmatter[key] = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      frontmatter[key] = value.slice(1, -1);
    } else {
      frontmatter[key] = value;
    }
  }

  if (inArray) frontmatter[currentKey] = arrayValues;

  frontmatter.body = match[2].trim();
  return frontmatter;
}

// ============================================
// 步骤 2: 校验稿件
// ============================================

function validateDraft(filename, fm) {
  const errors = [];

  // title
  if (!fm.title || fm.title.trim() === '') {
    errors.push('缺少 title');
  } else if (fm.title.length > 20) {
    errors.push(`标题超过20字限制（当前 ${fm.title.length} 字）: "${fm.title}"`);
  }

  // body
  if (!fm.body || fm.body.trim() === '') {
    errors.push('正文为空');
  } else {
    const charCount = fm.body.replace(/\s/g, '').length;
    if (charCount > 1000) {
      errors.push(`正文字数超限（当前 ${charCount} 字，小红书上限 1000 字）`);
    } else if (charCount > 800) {
      errors.push(`⚠️ 提醒: 正文字数接近上限（当前 ${charCount} 字，上限 1000 字）`);
    }
  }

  // images
  if (!fm.images || !Array.isArray(fm.images) || fm.images.length === 0) {
    errors.push('必须至少有 1 张图片');
  } else if (fm.images.length > 9) {
    errors.push(`图片不能超过 9 张（当前 ${fm.images.length} 张）`);
  } else {
    // 校验图片路径
    for (const img of fm.images) {
      const imgPath = resolve(ROOT, img);
      if (!existsSync(imgPath)) {
        errors.push(`图片不存在: ${img}`);
      }
    }
  }

  // tags
  if (!fm.tags || !Array.isArray(fm.tags) || fm.tags.length === 0) {
    errors.push('必须至少有 1 个话题标签');
  }

  // visibility
  const VALID_VIS = ['公开可见', '仅自己可见', '仅互关好友可见'];
  if (fm.visibility && !VALID_VIS.includes(fm.visibility)) {
    errors.push(`visibility 无效: "${fm.visibility}"，可选: ${VALID_VIS.join(', ')}`);
  }

  return errors;
}

// ============================================
// 步骤 3: 图片转 base64
// ============================================

async function imageToBase64(imagePath) {
  const absPath = resolve(ROOT, imagePath);
  const data = await readFile(absPath);
  const ext = imagePath.split('.').pop().toLowerCase();
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  const mime = mimeMap[ext] || 'image/jpeg';
  return `data:${mime};base64,${data.toString('base64')}`;
}

// ============================================
// 步骤 4: MCP 通信
// ============================================

function mcpCall(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const url = new URL(MCP_URL);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Key': API_KEY,
      'Content-Length': Buffer.byteLength(body),
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const req = https.request(
      { hostname: url.hostname, port: 443, path: url.pathname, method: 'POST', headers },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            resolve({ session: res.headers['mcp-session-id'], body: JSON.parse(data) });
          } catch (e) {
            resolve({ session: res.headers['mcp-session-id'], body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('MCP 请求超时')); });
    req.write(body);
    req.end();
  });
}

async function initSession() {
  const res = await mcpCall('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sol-xhs', version: '1.0' },
  });
  if (!res.session) throw new Error('初始化失败：未获取到 Session ID');
  return res.session;
}

async function checkLoginStatus(sessionId) {
  const res = await mcpCall('tools/call', { name: 'check_login_status', arguments: {} }, sessionId);
  const text = res.body?.result?.content?.[0]?.text;
  if (!text) throw new Error('检查登录状态失败');
  const status = JSON.parse(text);
  return status;
}

async function doPublish(sessionId, args) {
  const res = await mcpCall('tools/call', { name: 'publish_content', arguments: args }, sessionId);
  const text = res.body?.result?.content?.[0]?.text;
  if (!text) throw new Error('发布返回为空');
  return JSON.parse(text);
}

// ============================================
// 步骤 5: 记录日志
// ============================================

async function writeLog(filename, result) {
  const logFile = join(LOGS, `${filename.replace('.md', '')}.log.json`);
  await writeFile(logFile, JSON.stringify(result, null, 2), 'utf8');
  log(`日志已保存: logs/${basename(logFile)}`);
}

// ============================================
// 主流程
// ============================================

async function main() {
  console.log('');
  console.log('🍑  sol-xhs 发布器 v1.0');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 0. 环境检查
  await checkEnvironment();

  // 1. 扫描 drafts
  const files = await readdir(DRAFTS);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  if (mdFiles.length === 0) {
    console.log('📭 drafts/ 里没有稿件\n');
    process.exit(0);
  }

  // 解析并过滤 ready 状态的
  const readyDrafts = [];
  const skippedDrafts = [];

  for (const file of mdFiles) {
    const filePath = join(DRAFTS, file);
    const content = await readFile(filePath, 'utf8');
    try {
      const fm = parseFrontmatter(content);
      if (fm.status === 'ready') {
        readyDrafts.push({ file, filePath, fm });
      } else {
        skippedDrafts.push({ file, status: fm.status || '(未设置)' });
      }
    } catch (e) {
      log(`⚠️  ${file}: 解析失败 — ${e.message}`);
    }
  }

  if (skippedDrafts.length > 0) {
    console.log('⏭️  跳过（非 ready 状态）：');
    for (const s of skippedDrafts) {
      console.log(`   ${s.file}  → status: ${s.status}`);
    }
    console.log('');
  }

  if (readyDrafts.length === 0) {
    console.log('📭 没有 status: ready 的稿件\n');
    process.exit(0);
  }

  // 2. 展示待发列表
  console.log(`📋 发现 ${readyDrafts.length} 篇待发稿件：\n`);
  for (let i = 0; i < readyDrafts.length; i++) {
    const { file, fm } = readyDrafts[i];
    console.log(`  [${i + 1}] ${fm.title}`);
    console.log(`      📄 ${file}`);
    console.log(`      🏷️  ${fm.tags?.join(', ')}`);
    console.log(`      🖼️  ${fm.images?.length || 0} 张图`);
    console.log(`      👁️  ${fm.visibility || '公开可见'}`);
    console.log('');
  }

  // 3. 选择
  const ans = await ask(`输入编号预览(1-${readyDrafts.length}) / all 全部 / q 退出: `);

  if (ans.toLowerCase() === 'q') {
    console.log('👋 已取消\n');
    process.exit(0);
  }

  let selected = [];
  if (ans.toLowerCase() === 'all') {
    selected = readyDrafts;
  } else {
    const idx = parseInt(ans) - 1;
    if (isNaN(idx) || idx < 0 || idx >= readyDrafts.length) {
      console.log('❌ 无效选择\n');
      process.exit(1);
    }
    selected = [readyDrafts[idx]];
  }

  for (const draft of selected) {
    const { file, filePath, fm } = draft;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📝 预览: ${fm.title}`);
    console.log(`${'─'.repeat(50)}\n`);

    // 校验
    const errors = validateDraft(file, fm);
    if (errors.length > 0) {
      console.log('❌ 校验失败：');
      for (const e of errors) console.log(`   - ${e}`);
      console.log(`⏭️  跳过 ${file}\n`);
      continue;
    }
    console.log('✅ 校验通过');

    // 预览
    console.log(`\n  标题: ${fm.title}`);
    console.log(`  标签: ${fm.tags?.join(' ')}`);
    console.log(`  配图: ${fm.images?.length} 张`);
    console.log(`  可见: ${fm.visibility || '公开可见'}`);
    console.log(`  正文预览:\n  ┌${'─'.repeat(50)}`);
    const preview = fm.body.length > 200 ? fm.body.substring(0, 200) + '...' : fm.body;
    for (const line of preview.split('\n')) {
      console.log(`  │ ${line}`);
    }
    console.log(`  └${'─'.repeat(50)}`);

    const confirm = await ask('\n🚀 确认发布这篇？(yes/no): ');
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log(`⏭️  跳过 ${file}\n`);
      continue;
    }

    // 4. 转图片
    log('🖼️  转换图片...');
    const imageB64s = [];
    for (const img of fm.images) {
      const b64 = await imageToBase64(img);
      imageB64s.push(b64);
      log(`   ✅ ${basename(img)}`);
    }

    // 5. MCP 发布
    try {
      log('🔗 连接 MCP 服务器...');
      const sessionId = await initSession();
      log(`   Session: ${sessionId}`);

      log('🔐 检查登录状态...');
      const loginStatus = await checkLoginStatus(sessionId);
      if (!loginStatus.isLoggedIn) {
        throw new Error(`未登录小红书: ${loginStatus.message}`);
      }
      log(`   ✅ 已登录: ${loginStatus.userName} (${loginStatus.userId})`);

      log('📤 发布中...');
      const result = await doPublish(sessionId, {
        title: fm.title,
        content: fm.body,
        images: imageB64s,
        tags: fm.tags,
        visibility: fm.visibility || '公开可见',
      });

      if (result.success) {
        log(`🎉 发布成功！`);

        // 6. 更新状态 → 移到 published
        fm.status = 'published';
        const newContent = rebuildMarkdown(fm);
        const publishedPath = join(PUBLISHED, file);
        await writeFile(publishedPath, newContent, 'utf8');
        await rename(filePath, publishedPath).catch(async () => {
          // 如果跨设备重命名失败，直接写入
          await writeFile(publishedPath, newContent, 'utf8');
        });
        log(`📁 已归档: published/${file}`);

        // 7. 记录日志
        await writeLog(file, {
          publishedAt: timestamp(),
          file,
          title: fm.title,
          result,
        });
      } else {
        log(`❌ 发布失败: ${result.error || JSON.stringify(result)}`);
      }
    } catch (e) {
      log(`❌ 错误: ${e.message}`);
    }
  }

  console.log('\n🍑 完成！\n');
}

// ============================================
// 辅助: 重建 MD 文件（更新 status 字段）
// ============================================

function rebuildMarkdown(fm) {
  const lines = ['---'];
  lines.push(`title: "${fm.title}"`);
  lines.push(`status: ${fm.status}`);
  lines.push('tags:');
  for (const t of fm.tags) lines.push(`  - ${t}`);
  if (fm.images?.length) {
    lines.push('images:');
    for (const i of fm.images) lines.push(`  - ${i}`);
  }
  if (fm.visibility) lines.push(`visibility: ${fm.visibility}`);
  lines.push('---');
  lines.push('');
  lines.push(fm.body);
  lines.push('');
  return lines.join('\n');
}

// ============================================
// 启动
// ============================================

main().catch(e => {
  console.error(`\n💥 崩溃: ${e.message}`);
  process.exit(1);
});
