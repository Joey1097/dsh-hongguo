#!/usr/bin/env node
// HG2 客户端命令行：home / search / play
import { createClient, Hg2Error } from './index.js';

function usage() {
  console.log(`用法:
  hg2 home [模块序号]        列出一个首页模块的短剧
  hg2 modules                列出首页模块
  hg2 search <关键词>        搜索短剧
  hg2 free [数量] [页数]     筛出全集免费的短剧
  hg2 play <mediaId> [集号]  打印某一集的播放地址/密钥/分片数
`);
}

const [command, ...args] = process.argv.slice(2);
const client = await createClient();

try {
  if (!command || command === '-h' || command === '--help') {
    usage();
  } else if (command === 'modules') {
    for (const [index, module] of (await client.modules()).entries()) {
      console.log(index, module.id, module.moduleName);
    }
  } else if (command === 'home') {
    const modules = await client.modules();
    const index = Number(args[0] || 0);
    const module = modules[index];
    const page = await client.discover({ moduleId: module?.id, pageSize: 12 });
    console.log(`# ${module?.moduleName || page.moduleId} (hasMore=${page.hasMore})`);
    for (const item of page.items) {
      console.log(item.id, item.title, `EP${item.currentEpisode}/${item.totalEpisode}`);
    }
  } else if (command === 'search') {
    const keyword = args.join(' ');
    if (!keyword) throw new Error('缺少关键词');
    const { items, hasMore } = await client.search(keyword, { pageSize: 12 });
    console.log(`# 搜索「${keyword}」 hasMore=${hasMore}`);
    for (const item of items) {
      console.log(item.id, item.title, `EP${item.currentEpisode}/${item.totalEpisode}`);
    }
  } else if (command === 'free') {
    const limit = Number(args[0] || 20);
    const pages = Number(args[1] || 1);
    const result = await client.listFreeSeries({
      limit,
      pages,
      pageSize: 20,
      concurrency: 5,
      onScan: (item) => process.stderr.write(`\r扫描 ${String(item.title || '').slice(0, 18)}…`),
    });
    process.stderr.write('\n');
    console.log(`# 全集免费 ${result.items.length} 部（扫了 ${result.scanned}/${result.candidates} 部候选）`);
    for (const item of result.items) {
      console.log(item.id, item.title, `EP${item.freeEpisodes}/${item.totalEpisodes}`);
    }
  } else if (command === 'play') {
    const [mediaId, episodeArg] = args;
    if (!mediaId) throw new Error('缺少 mediaId');
    const { items } = await client.listEpisodes(mediaId, { pageSize: 200 });
    const wanted = episodeArg ? items.find((e) => String(e.episodeNumber) === String(episodeArg)) : items[0];
    const episode = wanted || items.find((e) => e.videoUrl);
    if (!episode) throw new Error('没有找到分集');
    const playback = await client.resolvePlayback(episode);
    console.log(JSON.stringify({
      episode: playback.episodeNumber,
      playlistURL: playback.playlistURL,
      keyURL: playback.keyURL,
      key: playback.key,
      segments: playback.segments.length,
    }, null, 2));
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof Hg2Error) {
    console.error(`[${error.code ?? 'ERR'}] ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
