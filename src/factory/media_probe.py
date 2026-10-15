"""Small preflight check for media files before they enter the task list."""
import argparse
import json
import sys
from pathlib import Path


def main(path_text: str) -> None:
    path = Path(path_text)
    if not path.is_file():
        raise ValueError('文件不存在或无法访问')
    if path.stat().st_size <= 0:
        raise ValueError('文件为空')

    import av

    try:
        opened = av.open(str(path), mode='r', metadata_errors='ignore')
    except TypeError:
        opened = av.open(str(path), mode='r')
    with opened as container:
        if not any(stream.type == 'video' for stream in container.streams):
            raise ValueError('没有找到视频轨道')
        audio_streams = [stream for stream in container.streams if stream.type == 'audio']
        if not audio_streams:
            raise ValueError('没有找到可识别的音频轨道')
        first_frame = next(container.decode(audio=0), None)
        if first_frame is None:
            raise ValueError('音频轨道无法解码')
        duration = None
        if container.duration is not None:
            duration = float(container.duration / av.time_base)
        print(json.dumps({'ok': True, 'duration': duration}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--path', required=True)
    try:
        main(parser.parse_args().path)
    except Exception as exc:
        print(json.dumps({'ok': False, 'message': str(exc)}, ensure_ascii=False))
        sys.exit(1)

