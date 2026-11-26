"""マイクで住人に話しかけるプログラム。

  python talk.py                      プッシュ・トゥ・トーク (F9 を押している間だけ録音)
  python talk.py --key ctrl_r         右Ctrlで話す
  python talk.py --mode always        常時会話 (話し始めと終わりを自動検出)
  python talk.py --mode text          マイクなしで文字入力 (動作確認用)

認識した文章は Node.js 側 (npm start) のローカルサーバー http://127.0.0.1:8765 に送られ、
進行役が「誰が返事するか」を決めて、住人が声で答える。
"""
from __future__ import annotations

import argparse
import json
import queue
import re
import sys
import threading
import time
import urllib.request
from pathlib import Path

MIC_FILE = Path(__file__).with_name("mic.txt")  # 選んだマイクを覚えておくファイル

SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000

# 無音や雑音で Whisper がよく作ってしまう「幻の文章」
HALLUCINATIONS = [
    "ご視聴ありがとうございました", "ご視聴ありがとうございます", "チャンネル登録", "おやすみなさい",
    "お疲れ様でした", "ありがとうございました", "字幕", "最後までご覧いただき", "次の動画で", "はじめしゃちょー",
]


def is_hallucination(text: str) -> bool:
    t = re.sub(r"[\s。、！？!?.,…・「」]", "", text or "")
    if len(t) < 2:
        return True
    if any(h in t and len(t) <= len(h) + 4 for h in HALLUCINATIONS):
        return True
    # 同じ文字列の繰り返し (例: "あああああ", "はいはいはいはい")
    for n in (1, 2, 3):
        if len(t) >= n * 4 and t == t[:n] * (len(t) // n) + t[: len(t) % n]:
            return True
    return False


# ---------------------------------------------------------------- Node.js 側との通信
class Server:
    def __init__(self, url: str, player: str | None):
        self.url = url.rstrip("/")
        self.player = player

    def _get(self, path: str, timeout=2.0):
        with urllib.request.urlopen(self.url + path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def send(self, text: str) -> bool:
        body = {"text": text}
        if self.player:
            body["player"] = self.player
        req = urllib.request.Request(self.url + "/utterance", data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers={"content-type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read().decode("utf-8")).get("ok", False)
        except Exception as e:  # noqa: BLE001
            print(f"  ✘ 送信失敗: {e} (npm start が動いているか確認)")
            return False

    def speaking(self) -> bool:
        try:
            return bool(self._get("/status", timeout=0.5).get("speaking"))
        except Exception:  # noqa: BLE001
            return False

    def names(self) -> list[str]:
        try:
            return self._get("/names").get("names", [])
        except Exception:  # noqa: BLE001
            return []


# ---------------------------------------------------------------- 発話区間の検出 (常時会話)
class Segmenter:
    """30ms ごとの音声フレームを受け取り、話し始め〜話し終わりの区間を切り出す。"""

    def __init__(self, aggressiveness=2, start_frames=6, end_ms=700, min_ms=400, max_s=15.0, energy_threshold=0.015):
        self.vad = None
        try:
            import webrtcvad  # type: ignore
            self.vad = webrtcvad.Vad(aggressiveness)
        except Exception:  # noqa: BLE001
            pass
        self.start_frames = start_frames
        self.end_frames = end_ms // FRAME_MS
        self.min_frames = min_ms // FRAME_MS
        self.max_frames = int(max_s * 1000 / FRAME_MS)
        self.energy_threshold = energy_threshold
        self.reset()

    def reset(self):
        self.pre: list = []
        self.frames: list = []
        self.in_speech = False
        self.voiced_run = 0
        self.silence_run = 0

    def is_speech(self, frame) -> bool:
        import numpy as np
        if self.vad is not None:
            pcm = (np.clip(frame, -1, 1) * 32767).astype("<i2").tobytes()
            return self.vad.is_speech(pcm, SAMPLE_RATE)
        return float(np.sqrt(np.mean(frame ** 2))) > self.energy_threshold

    def push(self, frame):
        """区間が完成したら numpy 配列を返す。それ以外は None。"""
        import numpy as np
        speech = self.is_speech(frame)
        if not self.in_speech:
            self.pre.append(frame)
            self.pre = self.pre[-self.start_frames - 5:]
            self.voiced_run = self.voiced_run + 1 if speech else 0
            if self.voiced_run >= self.start_frames:
                self.in_speech = True
                self.frames = list(self.pre)
                self.silence_run = 0
            return None
        self.frames.append(frame)
        self.silence_run = 0 if speech else self.silence_run + 1
        if self.silence_run >= self.end_frames or len(self.frames) >= self.max_frames:
            seg = self.frames
            self.reset()
            if len(seg) - self.end_frames >= self.min_frames:
                return np.concatenate(seg)
        return None


# ---------------------------------------------------------------- 音声認識
class Recognizer:
    def __init__(self, model: str, device: str, compute_type: str, hint: str):
        from faster_whisper import WhisperModel  # type: ignore
        print(f"Whisper モデル {model} を読み込み中 ({device}, {compute_type})… 初回はダウンロードに時間がかかります")
        self.model = WhisperModel(model, device=device, compute_type=compute_type)
        self.hint = hint

    def transcribe(self, audio) -> str:
        segments, _info = self.model.transcribe(
            audio, language="ja", beam_size=1, vad_filter=False,
            condition_on_previous_text=False, initial_prompt=self.hint or None,
        )
        return "".join(s.text for s in segments).strip()


def level(audio) -> float:
    import numpy as np
    return float(np.max(np.abs(audio))) if len(audio) else 0.0


def normalize(audio):
    """小さい声は大きくしてから認識する (Whisper は小さい音が苦手)"""
    peak = level(audio)
    if 0.003 < peak < 0.5:
        audio = audio * min(30.0, 0.6 / peak)
    return audio


def handle_audio(audio, rec: Recognizer, server: Server):
    dur = len(audio) / SAMPLE_RATE
    peak = level(audio)
    if peak < 0.003:
        print(f"  ✘ 音がほぼ入っていない (音量 {peak:.4f})。マイクが違うかも → 下の一覧から番号を選んで「mic 番号」と打って Enter")
        print_mics()
        return
    t0 = time.time()
    text = rec.transcribe(normalize(audio))
    took = time.time() - t0
    vol = "小さい" if peak < 0.05 else "OK"
    if is_hallucination(text):
        print(f"  (聞き取れなかった: 「{text}」 {dur:.1f}秒 / 音量 {peak:.3f}={vol} → 認識{took:.1f}秒)")
        if dur < 0.8:
            print("    → 短すぎるかも。F9 を押してから少し待って話し始め、話し終わってから離して")
        elif peak < 0.05:
            print("    → 声が小さい。マイクに近づくか、Windows のマイク音量を上げて (違うマイクなら「mic 番号」)")
        return
    print(f"🎤 「{text}」 ({dur:.1f}秒 → 認識{took:.1f}秒)")
    server.send(text)


# ---------------------------------------------------------------- マイクの選択
def input_devices():
    import sounddevice as sd
    out = []
    for i, d in enumerate(sd.query_devices()):
        if d.get("max_input_channels", 0) > 0:
            out.append((i, d["name"], sd.query_hostapis(d["hostapi"])["name"]))
    return out


def print_mics(current=None):
    try:
        print("  マイク一覧 (「mic 番号」で切り替え):")
        for i, name, api in input_devices():
            if api.startswith("Windows WDM-KS"):
                continue
            mark = " ← 使用中" if current is not None and str(current) == str(i) else ""
            print(f"    {i:>3}: {name} [{api}]{mark}")
    except Exception as e:  # noqa: BLE001
        print(f"  (マイク一覧を取れなかった: {e})")


def load_mic(arg):
    if arg:
        return int(arg) if str(arg).isdigit() else arg
    try:
        v = MIC_FILE.read_text(encoding="utf-8").strip()
        return int(v) if v.isdigit() else (v or None)
    except OSError:
        return None


def mic_name(mic):
    import sounddevice as sd
    try:
        return sd.query_devices(mic, "input")["name"]
    except Exception:  # noqa: BLE001
        return "?"


# ---------------------------------------------------------------- モード
def run_text(server: Server):
    print("文字で話しかけるモード。例: みんな、今日はダイヤを探しに行かない?")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        print("  → 送信" if server.send(line) else "")


def start_typing_thread(server: Server, on_mic=None):
    """マイクのウィンドウで文字を打って Enter でも話しかけられるようにする (日本語変換が普通に使える)
    「mic 番号」と打つとマイクを切り替える"""
    def loop():
        for line in sys.stdin:
            line = line.strip()
            m = re.fullmatch(r"(?:mic|マイク)\s*(\d+)", line, re.I)
            if m and on_mic:
                on_mic(int(m.group(1)))
                continue
            if line.lower() in ("mic", "マイク"):
                print_mics()
                continue
            if line:
                print("  → 送信" if server.send(line) else "")
    threading.Thread(target=loop, daemon=True).start()
    print("  ※ このウィンドウに文字を打って Enter でも話しかけられる (日本語変換OK)")


def run_ptt(server: Server, rec: Recognizer, key_name: str, mic):
    import numpy as np
    import sounddevice as sd
    from pynput import keyboard

    target = getattr(keyboard.Key, key_name, None) or keyboard.KeyCode.from_char(key_name)
    recording = threading.Event()
    chunks: list = []
    jobs: queue.Queue = queue.Queue()

    def callback(indata, _frames, _time, _status):
        if recording.is_set():
            chunks.append(indata[:, 0].copy())

    def on_press(k):
        if k == target and not recording.is_set():
            chunks.clear()
            recording.set()
            print("● 録音中… (キーを離すと送信)")

    def on_release(k):
        if k == target and recording.is_set():
            recording.clear()
            if chunks:
                audio = np.concatenate(chunks).astype("float32")
                if len(audio) / SAMPLE_RATE >= 0.3:
                    jobs.put(audio)

    def worker():
        while True:
            handle_audio(jobs.get(), rec, server)

    threading.Thread(target=worker, daemon=True).start()
    print(f"プッシュ・トゥ・トーク: [{key_name}] を押している間だけ録音します。Ctrl+C で終了")
    state = {"mic": mic}
    switch = threading.Event()

    def on_mic(n):
        state["mic"] = n
        try:
            MIC_FILE.write_text(str(n), encoding="utf-8")
        except OSError:
            pass
        switch.set()

    start_typing_thread(server, on_mic)
    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.start()
    while True:
        switch.clear()
        try:
            with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", device=state["mic"], callback=callback):
                print(f"🎙 マイク: {mic_name(state['mic'])}  (違うなら「mic」と打つと一覧が出る)")
                while not switch.wait(0.5):
                    pass
        except Exception as e:  # noqa: BLE001
            print(f"✘ マイク {state['mic']} を開けなかった: {e}")
            print_mics(state["mic"])
            if state["mic"] is not None:
                print("  → いつものマイク (Windows の既定) で開き直す")
                state["mic"] = None
                continue
            switch.wait()


def run_always(server: Server, rec: Recognizer, mic, echo_guard: bool):
    import numpy as np
    import sounddevice as sd

    seg = Segmenter()
    frames: queue.Queue = queue.Queue()
    jobs: queue.Queue = queue.Queue()
    speaking = threading.Event()

    def poll_speaking():
        # 住人の声がスピーカーから出ている間の音は使わない (自分の声を自分で拾う「エコー」対策)
        while True:
            if server.speaking():
                speaking.set()
            else:
                speaking.clear()
            time.sleep(0.2)

    def callback(indata, _frames, _time, _status):
        frames.put(indata[:, 0].copy())

    def worker():
        while True:
            handle_audio(jobs.get(), rec, server)

    if echo_guard:
        threading.Thread(target=poll_speaking, daemon=True).start()
    threading.Thread(target=worker, daemon=True).start()
    print("常時会話モード: 話しかけると自動で認識します。Ctrl+C で終了")
    start_typing_thread(server)
    print("  ※ スピーカーの声を拾わないよう、ヘッドホンの利用を推奨")
    buf = np.zeros(0, dtype="float32")
    tainted = False
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", device=mic, blocksize=FRAME_SAMPLES, callback=callback):
        while True:
            buf = np.concatenate([buf, frames.get()])
            while len(buf) >= FRAME_SAMPLES:
                frame, buf = buf[:FRAME_SAMPLES], buf[FRAME_SAMPLES:]
                if speaking.is_set():
                    tainted = True
                out = seg.push(frame)
                if not seg.in_speech and out is None and not speaking.is_set():
                    tainted = False
                if out is not None:
                    if tainted:
                        print("  (住人の発言中に拾った音なので無視)")
                    else:
                        jobs.put(out)
                    tainted = speaking.is_set()


def main(argv=None):
    ap = argparse.ArgumentParser(description="マイクでAI住人に話しかける")
    ap.add_argument("--mode", choices=["ptt", "always", "text"], default="ptt")
    ap.add_argument("--key", default="f9", help="プッシュ・トゥ・トークのキー (f9, ctrl_r, alt_r, v など)")
    ap.add_argument("--server", default="http://127.0.0.1:8765")
    ap.add_argument("--player", default=None, help="自分のMinecraftの名前 (省略時は settings の player.name)")
    ap.add_argument("--model", default="small", help="Whisperモデル: base / small / medium / large-v3-turbo など")
    ap.add_argument("--device", default="cpu", help="cpu か cuda (6GB GPU では LLM に譲って cpu 推奨)")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--mic", default=None, help="マイクの番号か名前 (python -m sounddevice で一覧)")
    ap.add_argument("--no-echo-guard", action="store_true", help="常時会話で、住人の発言中も録音を使う")
    a = ap.parse_args(argv)

    server = Server(a.server, a.player)
    if a.mode == "text":
        return run_text(server)
    names = server.names()
    hint = ("、".join(names) + "と話しています。") if names else ""
    try:
        rec = Recognizer(a.model, a.device, a.compute_type, hint)
    except Exception as e:  # noqa: BLE001
        print(f"✘ 音声認識を起動できなかった: {e}")
        print("  文字入力だけで続けます。")
        return run_text(server)
    mic = load_mic(a.mic)
    try:
        if a.mode == "ptt":
            run_ptt(server, rec, a.key, mic)
        else:
            run_always(server, rec, mic, not a.no_echo_guard)
    except KeyboardInterrupt:
        print("終了")


if __name__ == "__main__":
    main()
