# vflow

**把一条爆款短视频拆开，再按你要推的产品重新拍一遍。**

[![CI](https://github.com/zhangsf2233-sudo/vflow/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangsf2233-sudo/vflow/actions/workflows/ci.yml)

给一条参考视频（本地文件 / 直链 / 抖音等分享链接）和一张产品图，vflow 会：抽帧拆解它的钩子与节奏 → 写出 3 版复刻脚本 → 生成每段的参考首帧 → 调用视频模型产出分镜 → 用 ffmpeg 拼成一条带字幕的成片。

```
源片 ──抽帧──> 拆解(视觉模型) ──> 3 版脚本(对话模型) ──> 参考首帧(图片模型)
                                                        │
      final.mp4 <── 拼接/字幕/配轨(ffmpeg) <── 分镜视频(视频模型)
```

## 零成本先跑一遍

不需要任何 API Key，用本地 mock 网关把整条链路跑通，产出 10 秒成片：

```bash
npm install
npm run demo
# → output/demo/runs/<id>/final.mp4
```

测试素材由 ffmpeg 现场生成，mock 网关模拟对话 / 图片 / 视频三类接口，行为与真实服务同构。

## 用真模型跑

```bash
# 1. 检查环境（ffmpeg、配置、模型）
npx vflow doctor

# 2. 填三个模型（示例：火山方舟）
export VFLOW_CHAT_KEY=<你的 key>      VFLOW_CHAT_MODEL=doubao-seed-2-1-lite-260915
export VFLOW_IMAGE_KEY=<你的 key>     VFLOW_IMAGE_MODEL=doubao-seedream-5-0-flash-260915
export VFLOW_VIDEO_KEY=<你的 key>     VFLOW_VIDEO_MODEL=doubao-seedance-2-5-flash-261115

# 3. 跑
npx vflow run \
  --source ./reference.mp4 \
  --product-name "橙色气泡水" \
  --selling-points "九块九一罐，冰镇更爽" \
  --audience "上班族" \
  --product-image ./product.png
```

产物：

```
~/.vflow/runs/<runId>/
├── run.json        # 每一步的状态、耗时、日志（失败时先看这里）
├── frames/         # 拆解用的抽帧
├── images/         # 每段的参考首帧
├── clips/          # 每段的分镜视频
└── final.mp4       # 成片
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `vflow run --source <s>` | 跑完整流水线（`--variant A\|B\|C` 选脚本版本） |
| `vflow run --run-id <id> --resume` | 复用已完成的步骤重跑，失败重试不烧钱 |
| `vflow doctor` | 检查 ffmpeg / 配置 / 三个模型 |
| `vflow config` | 打印配置（密钥自动打码） |
| `vflow runs` | 历史运行列表 |

## 设计上的几个选择

**1. 按「段」生成，不按单镜生成。**
视频模型单次调用有镜头数与时长上限，还要按次计费。所以脚本先切段（默认 ≤5 镜、≤15 秒、单段固定 5 秒），一段一次调用。段内镜头靠提示词里的 `[镜头]` 分条描述，字幕按段内时间轴排。

**2. 每段都先生成参考首帧。**
直接文生视频，产品外观每段都会漂。先用图片模型把「产品图 + 本段第一个镜头」合成一张首帧，再让视频模型以它作为 `first_frame`，产品外观才稳得住。

**3. 推理模型的空回复兜底。**
推理模型会把 token 先花在 `reasoning_content` 上，`max_tokens` 给小了就会出现「content 为空、`finish_reason=length`」。`providers/chat.ts` 检测到这种情况自动把预算翻三倍重试一次，而不是直接报错。

**4. 状态落盘 + 可恢复。**
每步结束写一次 `run.json`。视频生成是最贵也最慢的一步，失败重跑时 `--resume` 会跳过已完成的步骤。

**5. 合成阶段先统一规格。**
不同模型产出的片段分辨率、帧率、像素格式都不一样，concat 分离器要求参数一致。所以先逐段 `scale/pad/setsar/fps` 归一，再无损拼接，最后烧字幕、配轨。

## 目录

```
src/
├── cli.ts                 # 命令行入口
├── config.ts              # 默认值 ← 配置文件 ← 环境变量
├── http.ts                # 带重试的 JSON 请求 / 下载
├── log.ts                 # 结构化日志（同时进 run.json）
├── files.ts               # 落盘、data URL、run 目录
├── media/
│   ├── ffmpeg.ts          # 抽帧 / 归一 / 拼接 / 配轨 / 烧字幕
│   └── ass.ts             # ASS 字幕生成
├── providers/
│   ├── chat.ts            # 对话 + 视觉（含推理模型兜底）
│   ├── image.ts           # 图片生成
│   └── video.ts           # Seedance 任务式接口（创建 → 轮询 → 下载）
└── pipeline/
    ├── source.ts          # 本地 / 直链 / yt-dlp 统一成一条视频
    ├── analyze.ts         # 抽帧 → 结构化拆解
    ├── script.ts          # 3 版脚本 → 切段 → 拼提示词
    ├── generate.ts        # 参考首帧 + 分镜视频
    ├── compose.ts         # 归一 → 拼接 → 字幕 → 音轨
    ├── run.ts             # 编排、状态落盘、resume
    └── prompts.ts         # 全部提示词（拆解 / 仿写 / 首帧 / 分段）
```

## 配置

优先级：**默认值 ← `~/.vflow/config.json` ← 环境变量**。

| 环境变量 | 说明 |
| --- | --- |
| `VFLOW_CHAT_BASE` / `VFLOW_CHAT_KEY` / `VFLOW_CHAT_MODEL` | 对话与视觉模型（OpenAI 兼容 `/chat/completions`） |
| `VFLOW_IMAGE_BASE` / `VFLOW_IMAGE_KEY` / `VFLOW_IMAGE_MODEL` | 图片模型（`/images/generations`） |
| `VFLOW_VIDEO_BASE` / `VFLOW_VIDEO_KEY` / `VFLOW_VIDEO_MODEL` | 视频模型（Seedance 任务接口） |
| `VFLOW_DATA_DIR` | 运行产物目录，默认 `~/.vflow/runs` |
| `VFLOW_CONFIG` | 配置文件路径 |
| `VFLOW_FFMPEG` / `VFLOW_FFPROBE` / `VFLOW_YTDLP` | 二进制路径 |

## 测试

```bash
npm test          # 单测 + 端到端（真 ffmpeg + mock 网关，不出网）
npm run typecheck
```

端到端测试会实际跑完六步并断言成片时长、段数、模型调用次数，以及 resume 不会重复调用模型。

## 已知限制

- 只实现了 Seedance 一种视频协议；接别的视频服务需要改 `providers/video.ts`。
- 分享链接解析依赖外部的 `yt-dlp`，平台风控严时会失败。
- 没有 TTS：口播以字幕呈现，音轨沿用源片。
- 单条成片 10–20 秒，长视频需要自己做分段编排。

## 参考与致谢

流水线的**六步形态**参考了开源项目 [dsh-video-replica](https://github.com/limomss-dunang/dsh-video-replica)（Apache-2.0）的设计思路；本仓库的代码、模块划分与提示词均为独立重写，未复制其源码。如果你要在这个方向上继续做，建议也去看一眼原项目——它在 DSH 插件形态上做得更完整。

## License

Apache-2.0，见 [LICENSE](./LICENSE)。
