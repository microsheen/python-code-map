"""通用工具函数。

shapes.py / main.py 都依赖这里，用来演示跨文件的调用连边。
"""
import math
import os


def clamp(value, low=0.0, high=1.0):
    """把 value 夹在 [low, high] 之间。"""
    if value < low:
        return low
    if value > high:
        return high
    return value


def norm(x, y):
    """向量长度。math.sqrt 是外部调用 -> external，不连边。"""
    return math.sqrt(x * x + y * y)


def calc(values, limit=10):
    """调用同文件的 norm 与 clamp；round 是内置 -> external。"""
    total = 0.0
    for v in values:
        total = total + norm(v, limit)
    return round(clamp(total), 3)


def strip_comment(line):
    """去掉行尾注释。字符串方法调用不产生边。"""
    return line.split('#', 1)[0].strip()


def parse_lines(data):
    """data.splitlines() 的接收者是普通变量 -> dynamic。"""
    out = []
    for raw in data.splitlines():
        text = strip_comment(raw)
        if text:
            out.append(text)
    return out


def read_text(path):
    """open 是内置 -> external。"""
    with open(path, 'r', encoding='utf-8') as fh:
        return fh.read()


def load_config(path):
    """一个函数里连着调用两个同文件函数。"""
    return parse_lines(read_text(path))


def helper(tag='utils'):
    """与 shapes.helper 同名：显式 import 时仍能连到正确的那个。"""
    return tag + ':helper'


async def fetch_one(url):
    """len 是内置 -> external。"""
    return len(url)


async def fetch_all(urls):
    """await fetch_one(...) -> resolved。"""
    out = []
    for u in urls:
        out.append(await fetch_one(u))
    return out


def outer(values):
    """嵌套函数：inner 调用外层可见的 clamp。"""

    def inner(x):
        return clamp(x)

    return [inner(v) for v in values]


class Registry:
    """注册表。self.validate -> 连到 Registry.validate。"""

    def __init__(self, name):
        self.name = name
        self.items = {}

    def validate(self, key):
        """bool / isinstance 都是内置 -> external。"""
        return bool(key) and isinstance(key, str)

    def add(self, key, value):
        if not self.validate(key):
            raise ValueError(key)
        self.items[key] = value
        return self


def make_registry(name):
    """Registry(...) -> 连到 Registry.__init__（构造函数）。"""
    reg = Registry(name)
    reg.add('os', os.name)
    return reg
