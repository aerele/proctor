#!/bin/python3

import math
import os
import random
import re
import sys

#
# Complete the 'minCoins' function below.
#
# The function is expected to return an INTEGER.
# The function accepts INTEGER n as parameter.
#

def minCoins(n):
    c = 0
    for d in (25, 10, 5, 1):
        c += n // d
        n %= d
    return c

if __name__ == '__main__':
    fptr = sys.stdout

    n = int(input().strip())

    result = minCoins(n)

    fptr.write(str(result) + '\n')

