"""talk.py の単体テスト (マイク・Whisper 不要)。  python -m pytest voice_input  または  python voice_input/test_talk.py"""
import numpy as np

from talk import FRAME_SAMPLES, SAMPLE_RATE, Segmenter, is_hallucination


def test_hallucination_filter():
    assert is_hallucination("ご視聴ありがとうございました")
    assert is_hallucination("あ")
    assert is_hallucination("はいはいはいはいはい")
    assert not is_hallucination("ずんだもん、木を集めてきて")
    assert not is_hallucination("みんな、ダイヤ探しに行かない?")


def _frames(signal):
    for i in range(0, len(signal) - FRAME_SAMPLES + 1, FRAME_SAMPLES):
        yield signal[i:i + FRAME_SAMPLES]


def test_segmenter_energy():
    seg = Segmenter()
    seg.vad = None  # 音量判定で確認
    rng = np.random.default_rng(0)
    silence = rng.normal(0, 0.002, SAMPLE_RATE).astype("float32")
    t = np.arange(int(SAMPLE_RATE * 1.2)) / SAMPLE_RATE
    voice = (0.2 * np.sin(2 * np.pi * 220 * t)).astype("float32")
    out = [s for f in _frames(np.concatenate([silence, voice, silence])) if (s := seg.push(f)) is not None]
    assert len(out) == 1
    assert 1.0 < len(out[0]) / SAMPLE_RATE < 2.2


def test_segmenter_ignores_click():
    seg = Segmenter()
    seg.vad = None
    sig = np.zeros(SAMPLE_RATE, dtype="float32")
    sig[8000:8000 + FRAME_SAMPLES * 2] = 0.5  # 60ms のクリック音
    assert [s for f in _frames(sig) if (s := seg.push(f)) is not None] == []


if __name__ == "__main__":
    test_hallucination_filter(); test_segmenter_energy(); test_segmenter_ignores_click()
    print("ok")
