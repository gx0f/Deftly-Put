"""Best-effort, on-device language identification for edits to an accepted reply."""

from ctypes import (CDLL, POINTER, Structure, c_bool, c_char, c_char_p, c_long,
                    c_uint32, c_void_p, create_string_buffer)


class CFRange(Structure):
    _fields_ = [("location", c_long), ("length", c_long)]


def detect_edit_language(text):
    if not any(char.isalpha() for char in text):
        return ""
    try:
        encoded = text.encode("utf-8")
        core = CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")

        def bind(name, result_type, *argument_types):
            fn = getattr(core, name)
            fn.restype = result_type
            fn.argtypes = argument_types
            return fn

        create = bind("CFStringCreateWithBytes", c_void_p, c_void_p, c_char_p, c_long, c_uint32, c_bool)
        length = bind("CFStringGetLength", c_long, c_void_p)
        identify = bind("CFStringTokenizerCopyBestStringLanguage", c_void_p, c_void_p, CFRange)
        copy = bind("CFStringGetCString", c_bool, c_void_p, POINTER(c_char), c_long, c_uint32)
        release = bind("CFRelease", None, c_void_p)
    except (OSError, AttributeError, UnicodeError):
        return ""

    utf8 = 0x08000100  # kCFStringEncodingUTF8
    string = create(None, encoded, len(encoded), utf8, False)
    if not string:
        return ""
    language = None
    try:
        # CFRange uses UTF-16 code units; neither Python length nor byte length suffices.
        language = identify(string, CFRange(0, length(string)))
        buffer = create_string_buffer(64)
        if language and copy(language, buffer, len(buffer), utf8):
            return buffer.value.decode("utf-8")
        return ""
    finally:
        if language:
            release(language)
        release(string)
