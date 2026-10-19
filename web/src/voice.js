/**
 * 语音输入（锁定决策 #10：只做安卓 Chrome 的 webkitSpeechRecognition）。
 *
 * 为什么用浏览器自带识别：
 * - 一句话录入拼的是「说完就能确认」，系统识别器中文质量够用、不花钱、不用上传音频；
 * - 自己录 PCM 送云端要做降噪/断句/费用/隐私处理，对单人自用项目是纯负担。
 *
 * 边界（写进手册，别让用户踩）：
 * - iOS/Safari 没有这个 API → supported() 返回 false，页面提示「用文字输入」；
 * - 手机必须 HTTPS（麦克风与 PWA 同一套限制，见 HANDOFF 已知坑）；
 * - 识别失败不阻断录入，用户改打字即可。
 */

const SR =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

/** 当前设备能不能用系统语音识别 */
export function voiceSupported() {
  return Boolean(SR);
}

/**
 * 创建一个识别器。每次开始说话前重新建，避免上一轮的中间结果残留。
 * onPartial(text)  实时文字（边说边显示，让用户知道识别在工作）
 * onFinal(text)    最终文字（isFinal 的那一段）
 * onError(code)    错误码（not-allowed / no-speech / network / aborted…）
 * onEnd()          识别结束（无论成功失败都会来，用来复位按钮状态）
 */
export function createRecognizer({ lang = 'zh-CN', onPartial, onFinal, onError, onEnd } = {}) {
  if (!SR) return null;

  const rec = new SR();
  rec.lang = lang;
  rec.continuous = false; // 一句话场景：说完自动停
  rec.interimResults = true; // 要实时反馈，不能等整句
  rec.maxAlternatives = 1;

  let finalText = '';

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript || '';
      if (result.isFinal) finalText += text;
      else interim += text;
    }
    if (interim && onPartial) onPartial(finalText + interim);
    if (finalText && onFinal) onFinal(finalText);
  };

  rec.onerror = (event) => {
    if (onError) onError(event.error || 'error');
  };

  rec.onend = () => {
    if (onEnd) onEnd(finalText);
  };

  return {
    start() {
      finalText = '';
      rec.start();
    },
    stop() {
      rec.stop();
    },
    abort() {
      rec.abort();
    },
  };
}
