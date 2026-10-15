"""入口脚本。

覆盖四种 import 写法：
    import utils                 -> utils.load_config()
    import shapes as sh          -> sh.helper()
    from utils import calc       -> calc()
    from . import shapes as rel  -> rel.helper()（相对导入）
"""
import utils
import shapes as sh

from utils import calc, clamp
from shapes import Circle, total_area
from . import shapes as rel


def log(message):
    """print / str 是内置 -> external。"""
    print('[main] ' + str(message))


def boot():
    """utils.load_config() 与 sh.helper() 都是跨文件调用。"""
    cfg = utils.load_config('config.txt')
    log(cfg)
    return sh.helper('boot')


def report(values):
    """calc / clamp 来自 from utils import ...；utils.norm 走模块属性。"""
    total = calc(values)
    return clamp(total) + utils.norm(1, 2)


def draw(radius):
    """Circle(...) -> 构造函数；c.describe() 接收者是变量 -> dynamic。"""
    c = Circle(radius)
    log(c.describe())
    return total_area([c])


def factorial(n):
    """递归 -> 图上的自环。"""
    if n <= 1:
        return 1
    return n * factorial(n - 1)


def outer(items):
    """嵌套函数：run 调用 step，step 调用 clamp。"""

    def step(x):
        return clamp(x)

    def run(xs):
        return [step(x) for x in xs]

    return run(items)


def describe(tag):
    """第一次定义。"""
    return 'describe:' + tag


def describe(tag, suffix='!'):
    """第二次定义（同名）。"""
    return 'describe:' + tag + suffix


def use_describe(tag):
    """同名两个 describe -> ambiguous，不连边。"""
    return describe(tag)


def rel_helper():
    """相对导入 from . import shapes as rel -> rel.helper()。"""
    return rel.helper('rel')


class Pipeline:
    """self.finish -> 连到 Pipeline.finish；s.run_one() -> dynamic。"""

    def __init__(self, name):
        self.name = name

    def finish(self):
        return len(self.name)

    def run(self, steps):
        out = []
        for s in steps:
            out.append(s.run_one())
        return self.finish() + len(out)


def build_pipeline(name):
    """Pipeline(...) -> 构造函数。"""
    p = Pipeline(name)
    return p.finish()


def dynamic_call(obj, fname):
    """getattr 是内置 -> external；fn() 接收者是局部变量 -> dynamic。"""
    fn = getattr(obj, fname)
    return fn()


async def main():
    """async 入口：把上面这些函数都调一遍。"""
    boot()
    report([1, 2, 3])
    draw(2.0)
    log(factorial(5))
    outer([0.1, 0.2])
    use_describe('x')
    rel_helper()
    build_pipeline('demo')
    dynamic_call(utils, 'helper')


if __name__ == '__main__':
    log('start')
    main()
