"""几何形状。

演示 from utils import clamp, norm 这种“直接导入函数”的跨文件连边，
以及继承（Circle -> Shape）下 self.area() 的解析。
"""
import math

from utils import clamp, norm


class Shape:
    """基类。describe 里的 self.area() 连到 Shape.area。"""

    def area(self):
        return 0.0

    def describe(self):
        """str / round 是内置 -> external。"""
        return 'area=' + str(round(self.area(), 2))


class Circle(Shape):
    """继承 Shape。__init__ 里用跨文件导入的 clamp。"""

    def __init__(self, radius=1.0):
        self.radius = clamp(radius, 0.0, 100.0)

    def area(self):
        """math.pi 不是调用；这里没有内部边。"""
        return math.pi * self.radius * self.radius

    def scale(self, factor):
        """Circle(...) -> 连到 Circle.__init__。"""
        return Circle(self.radius * clamp(factor, 0.1, 10.0))


class Rect(Shape):
    """corners 用跨文件导入的 norm。"""

    def __init__(self, w, h):
        self.w = w
        self.h = h

    def corners(self):
        return norm(self.w, self.h)


def total_area(shapes):
    """s.area() 的接收者是普通变量 -> dynamic，不连边。"""
    total = 0.0
    for s in shapes:
        total = total + s.area()
    return total


def helper(tag='shapes'):
    """与 utils.helper 同名。main.py 里 sh.helper() 连到这里。"""
    return tag + ':helper'


def unit_circle():
    """Circle(...) -> 连到 Circle.__init__。"""
    return Circle(1.0)


def make_pair(radius):
    """一行里出现三个调用：total_area / unit_circle / Circle。"""
    return total_area([unit_circle(), Circle(radius)])
