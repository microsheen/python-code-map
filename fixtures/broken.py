"""故意写坏的样例：验收“单文件语法错误不影响其余文件出图”。"""


def ok_part(:
    return 1


def still_ok():
    return ok_part()
