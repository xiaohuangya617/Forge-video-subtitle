# Third-party notices

本目录不是单一许可证项目。作者原创代码按根目录的 `PROJECT-LICENSE.md` 采用 MIT；以下运行库、模型和来源代码继续按各自许可证执行。

## 当前发布包中的模型与组件

- `models/faster-whisper-small`：来自 Systran 的 CTranslate2 Whisper Small 转换模型，随模型目录保留 MIT 元数据；原始 Whisper 模型及 CTranslate2/faster-whisper 依赖仍按上游条款执行。来源：[Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small)。
- `models/Hy-MT2-1.8B-Q4_K_M.gguf`：来自 Tencent Hy-MT2-1.8B-GGUF 系列，模型卡标示 Apache License 2.0；量化文件和 llama.cpp 运行组件应继续遵守上游条款。来源：[Tencent Hy-MT2-1.8B-GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF)。
- Electron、Chromium、Python、PyAV、llama.cpp、CTranslate2、NumPy、OpenCV、Requests 及其他依赖：许可证和版权材料随运行目录中的 `LICENSE`、`LICENSES.chromium.html`、`resources/runtime`、`resources/runtime/vendor` 及各 `*.dist-info` 目录保留。

ASR scene presets in presets.js are adapted from Transub Core src/js/subtitle-glossary-core.js, commit 1b659c9. Copyright (c) 2026 Transub. MIT terms are retained in licenses/Transub-LICENSE.txt. Source: https://github.com/dlsandy/Transub

No Pro reconstruction, film understanding, bilingual review or _advanced code is included.

Optional Japanese cross-check models in the 1.10 package:

- Moonshine Japanese Small Streaming, downloaded from `https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23`. The downloader currently identifies this checkpoint as being under the Moonshine Community License; review `https://www.moonshine.ai/license` before redistributing commercially.
- `reazonspeech-k2-v2`, downloaded from `https://huggingface.co/reazon-research/reazonspeech-k2-v2`. The model is Apache License 2.0. Its license text is available at `https://www.apache.org/licenses/LICENSE-2.0`.

The optional models are disabled by default. Selecting them runs each model in a separate background process and may substantially increase processing time.
