"""Shared subtitle display normalization for product delivery paths."""

import unicodedata


def normalize_subtitle_display(text: str) -> str:
    """Remove ordinary punctuation while preserving decimal and grouping separators."""
    result = []
    for index, char in enumerate(text):
        previous = text[index - 1] if index else ''
        following = text[index + 1] if index + 1 < len(text) else ''
        between_digits = (char in '.,:：/-' and '0' <= previous <= '9'
                          and '0' <= following <= '9')
        between_letters = (char in "'’-" and previous.isascii() and previous.isalpha()
                           and following.isascii() and following.isalpha())
        number_suffix = char in '%％‰' and '0' <= previous <= '9'
        punctuation = unicodedata.category(char).startswith('P') or char in '~～'
        result.append(' ' if punctuation and not (between_digits or between_letters or number_suffix) else char)
    return ' '.join(''.join(result).split())
