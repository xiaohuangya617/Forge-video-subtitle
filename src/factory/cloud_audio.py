"""Extract the first audio track to a small, API-friendly WAV file.

The factory already ships PyAV for local recognition, so cloud recognition
does not need a second ffmpeg distribution.
"""
import argparse
import os
import wave


def extract(source, target):
    import av
    container = av.open(str(source))
    stream = next(iter(container.streams.audio), None)
    if stream is None:
        container.close()
        raise RuntimeError('没有可用的音频轨道')
    resampler = av.audio.resampler.AudioResampler(format='s16', layout='mono', rate=16000)
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    try:
        with wave.open(str(target), 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            for frame in container.decode(stream):
                for item in (resampler.resample(frame) or []):
                    wav.writeframes(item.to_ndarray().reshape(-1).astype('int16').tobytes())
            for item in (resampler.resample(None) or []):
                wav.writeframes(item.to_ndarray().reshape(-1).astype('int16').tobytes())
    finally:
        container.close()
    if os.path.getsize(target) < 128:
        raise RuntimeError('提取的音频为空，请检查视频音频轨道')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    args = parser.parse_args()
    extract(args.source, args.target)


if __name__ == '__main__':
    main()
