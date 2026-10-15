/**
 * Python 内置名与标准库顶层模块名单。
 *
 * 只用于把"明确不是本项目代码"的调用归类为 external，
 * 名单不全也不会产生错误连边——未知名会落到 unknown。
 */

export const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  // 函数
  'abs', 'aiter', 'all', 'any', 'anext', 'ascii', 'bin', 'breakpoint', 'callable', 'chr',
  'classmethod', 'compile', 'delattr', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
  'format', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'isinstance',
  'issubclass', 'iter', 'len', 'locals', 'map', 'max', 'min', 'next', 'oct', 'open', 'ord',
  'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'setattr', 'sorted',
  'staticmethod', 'sum', 'super', 'vars', 'zip', '__import__',
  // 类型
  'bool', 'bytearray', 'bytes', 'complex', 'dict', 'float', 'frozenset', 'int', 'list',
  'object', 'set', 'slice', 'str', 'tuple', 'type', 'BaseException', 'Exception',
  'ArithmeticError', 'AssertionError', 'AttributeError', 'BlockingIOError', 'BrokenPipeError',
  'BufferError', 'BytesWarning', 'ChildProcessError', 'ConnectionAbortedError',
  'ConnectionError', 'ConnectionRefusedError', 'ConnectionResetError', 'DeprecationWarning',
  'EOFError', 'EnvironmentError', 'FileExistsError', 'FileNotFoundError', 'FloatingPointError',
  'FutureWarning', 'GeneratorExit', 'IOError', 'ImportError', 'ImportWarning',
  'IndentationError', 'IndexError', 'InterruptedError', 'IsADirectoryError', 'KeyError',
  'KeyboardInterrupt', 'LookupError', 'MemoryError', 'ModuleNotFoundError', 'NameError',
  'NotADirectoryError', 'NotImplementedError', 'OSError', 'OverflowError', 'PendingDeprecationWarning',
  'PermissionError', 'ProcessLookupError', 'RecursionError', 'ReferenceError', 'ResourceWarning',
  'RuntimeError', 'RuntimeWarning', 'StopAsyncIteration', 'StopIteration', 'SyntaxError',
  'SyntaxWarning', 'SystemError', 'SystemExit', 'TabError', 'TimeoutError', 'TypeError',
  'UnboundLocalError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError',
  'UnicodeTranslateError', 'UnicodeWarning', 'UserWarning', 'ValueError', 'Warning',
  'ZeroDivisionError', 'True', 'False', 'None', 'NotImplemented', 'Ellipsis',
  // typing 常见名
  'Any', 'Optional', 'Union', 'List', 'Dict', 'Set', 'Tuple', 'Callable', 'Iterable',
  'Iterator', 'Sequence', 'Mapping', 'TypedDict', 'TypeVar', 'Generic', 'Protocol', 'Literal',
]);

/** 标准库顶层模块（节选常用项，足以覆盖自动化脚本场景） */
export const STDLIB_MODULES: ReadonlySet<string> = new Set([
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'base64', 'binascii', 'bisect', 'builtins',
  'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs', 'codeop',
  'collections', 'colorsys', 'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
  'copyreg', 'cProfile', 'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm',
  'decimal', 'difflib', 'dis', 'distutils', 'doctest', 'email', 'encodings', 'enum', 'errno',
  'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools',
  'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq',
  'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale', 'logging',
  'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder',
  'multiprocessing', 'netrc', 'nis', 'nntplib', 'numbers', 'operator', 'optparse', 'os',
  'ossaudiodev', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform',
  'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd',
  'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve',
  'shlex', 'shutil', 'signal', 'site', 'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver',
  'sqlite3', 'sre_compile', 'sre_constants', 'sre_parse', 'ssl', 'stat', 'statistics', 'string',
  'stringprep', 'struct', 'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog',
  'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'test', 'textwrap', 'threading',
  'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback',
  'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata', 'unittest',
  'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg',
  'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib',
  '_thread', '__future__',
]);

/** 常见第三方库顶层模块：判定为 external */
export const THIRD_PARTY_MODULES: ReadonlySet<string> = new Set([
  'numpy', 'np', 'pandas', 'pd', 'scipy', 'matplotlib', 'plt', 'seaborn', 'sns', 'sklearn',
  'tensorflow', 'tf', 'torch', 'requests', 'httpx', 'aiohttp', 'flask', 'django', 'fastapi',
  'pydantic', 'sqlalchemy', 'pymongo', 'redis', 'boto3', 'botocore', 'azure', 'msal',
  'msgraph', 'office365', 'O365', 'shareplum', 'yaml', 'pyyaml', 'toml', 'dotenv', 'click',
  'typer', 'rich', 'tqdm', 'pytest', 'bs4', 'lxml', 'scrapy', 'selenium', 'playwright',
  'openpyxl', 'xlsxwriter', 'xlrd', 'pyodbc', 'psycopg2', 'paramiko', 'fabric', 'celery',
  'jinja2', 'dateutil', 'pytz', 'tzlocal', 'chardet', 'certifi', 'urllib3', 'idna', 'six',
  'pkg_resources', 'setuptools', 'pip', 'wheel', 'PIL', 'cv2', 'PyPDF2', 'pdfplumber',
  'fitz', 'docx', 'pptx', 'win32com', 'win32api', 'pythoncom', 'comtypes', 'uipath',
]);

export function isExternalModuleHead(head: string): boolean {
  return STDLIB_MODULES.has(head) || THIRD_PARTY_MODULES.has(head);
}

export function isBuiltinName(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}
