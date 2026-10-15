"""Shared native-model cache and auxiliary work files on the application drive."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


def cache_root():
    override = os.environ.get('SUBTITLE_FACTORY_CACHE_DIR')
    root = Path(override) if override else Path(Path(__file__).resolve().anchor) / 'SubtitleFactoryCache'
    root = root.resolve()
    if not str(root).isascii():
        raise RuntimeError('副模型缓存目录必须使用英文路径')
    root.mkdir(parents=True, exist_ok=True)
    return root


def work_dir():
    root = cache_root() / 'work'
    root.mkdir(exist_ok=True)
    return root


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024), b''):
            digest.update(block)
    return digest.hexdigest()


def manifest(source):
    return [{'name':p.relative_to(source).as_posix(), 'size':p.stat().st_size, 'sha256':file_hash(p)}
            for p in sorted(source.rglob('*')) if p.is_file()]


def valid(target, files):
    try:
        if json.loads((target/'.complete.json').read_text('utf-8')) != files:
            return False
        return all((p:=target/x['name']).is_file() and p.stat().st_size==x['size']
                   and file_hash(p)==x['sha256'] for x in files)
    except (OSError, ValueError):
        return False


def safe_model_dir(source, label):
    source = Path(source).resolve()
    if not source.is_dir():
        raise FileNotFoundError(f'{label} 模型目录不存在：{source}')
    if str(source).isascii():
        return source
    try:
        buf = ctypes.create_unicode_buffer(32768)
        length = ctypes.windll.kernel32.GetShortPathNameW(str(source), buf, len(buf))
        if length and buf.value.isascii():
            return Path(buf.value)
    except (AttributeError, OSError):
        pass
    if label not in ('moonshine', 'reazonspeech'):
        raise ValueError('不支持的副模型缓存类型')
    files = manifest(source)
    if not files:
        raise RuntimeError(f'{label} 模型目录为空')
    digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:24]
    root = cache_root() / 'models'
    root.mkdir(exist_ok=True)
    target = root / f'{label}-{digest}'
    if valid(target, files):
        return target
    required = sum(x['size'] for x in files) + 64*1024*1024
    if shutil.disk_usage(root).free < required:
        raise RuntimeError(f'副模型缓存所在盘空间不足，需要至少 {required//1024//1024} MB：{root}')
    # Never expose a partial copy as a complete model. Concurrent runs may share it.
    staging = Path(tempfile.mkdtemp(prefix=f'{label}-building-', dir=root))
    try:
        for entry in files:
            dst = staging / entry['name']
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source/entry['name'], dst)
        if any(file_hash(staging/x['name']) != x['sha256'] for x in files):
            raise RuntimeError('副模型缓存校验失败，原始模型未改动')
        (staging/'.complete.json').write_text(json.dumps(files), 'utf-8')
        if target.exists() and not valid(target, files):
            # Preserve an invalid cache for diagnosis rather than deleting unknown data.
            invalid = root / (target.name+'-invalid-'+staging.name.rsplit('-',1)[-1])
            target.rename(invalid)
        try:
            staging.rename(target)
        except FileExistsError:
            if not valid(target, files):
                raise
        return target
    finally:
        if staging.exists():
            shutil.rmtree(staging)
