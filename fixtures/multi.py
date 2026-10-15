# multi.py: one caller that invokes the same function three times.
def callee(x):
    return x + 1

def caller():
    total = callee(1)
    total += callee(2)
    return total + callee(3)
