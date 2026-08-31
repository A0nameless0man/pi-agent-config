/**
 * vision-nudge — 当前模型具备视觉能力(model.input 含 "image")时,向 system prompt
 * 追加视觉能力使用指引,推动模型主动读图、对可视化产出自检,而非凭文字描述臆测。
 *
 * text-only 模型不注入——注入了也无法执行,白白占用上下文。主会话默认模型多为
 * text-only(pro 档),本扩展实际生效于:
 *   - 用户 /model 临时切到视觉模型时
 *   - 视觉系子代理(visual / visual-worker)的会话
 *
 * 同步 handler、无任何 await,规避 session replacement 后访问 stale ctx 的问题
 * (参考 pi-dev-context / openviking 扩展的教训),勿在 handler 中引入 await。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDANCE = `
<vision_capability>
当前模型可以直接读取图片(read 工具)。主动、充分地使用视觉能力:
- 涉及截图、设计稿、渲染结果、图表、示意图、扫描件、照片时,先用 read 实际读图获取一手信息;禁止仅凭文字描述或想象推断图像内容
- 产出可视化结果(UI 页面、图表、图形、仿真画面)后,主动截图/导出并读图自检,再交付
- 对比类任务(设计稿 vs 实现、修改前后)必须读图逐项核对,列出差异及位置
- 读不清时用 bash 预处理(放大、裁剪、转格式,如 pdftoppm / ImageMagick)后再读;仍不确定的细节明确标注 unclear,不要编造
- 需要隔离的深度图像分析可派 visual / visual-worker 子代理,避免大图占用主上下文
</vision_capability>`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    if (!ctx.model?.input?.includes("image")) return;
    return { systemPrompt: event.systemPrompt + "\n" + GUIDANCE };
  });
}
