"""
Модульные тесты изолированного сервиса парсинга и валидации медиа-ресурсов media_parser.py.
Проверяют корректность разбора ссылок доверенных провайдеров (YouTube, VK, Rutube, Yandex),
прямых HTTPS-аудиофайлов, нормализацию хостов, защиту от фишинга, поддельных доменов,
опасных схем и дефектных идентификаторов контента без сетевых обращений.
"""

import pytest

from app.services.media_parser import (
    DIRECT_AUDIO_EXTENSIONS,
    InvalidMediaUrlError,
    MediaParserError,
    MediaProvider,
    MediaType,
    ParsedMediaResource,
    UnsupportedMediaProviderError,
    is_direct_audio_url,
    match_provider_by_host,
    normalize_url_host,
    parse_media_url,
)


@pytest.mark.unit
def test_parse_youtube_valid_urls() -> None:
    """
    Проверка корректного распознавания и парсинга допустимых форматов ссылок YouTube:
    полных URL watch, мобильных m.youtube.com, коротких youtu.be, shorts, embed и youtube-nocookie.com.
    Убеждается в формировании канонического embed_url на базе youtube-nocookie.com
    и отсечении паразитных параметров запроса из адреса встраивания.
    """
    valid_urls = [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        "https://www.youtube.com/embed/dQw4w9WgXcQ",
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&feature=shared",
    ]
    expected_resource_id = "dQw4w9WgXcQ"
    expected_embed_url = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"

    for url in valid_urls:
        resource = parse_media_url(url)

        # Проверка контракта возвращаемой структуры
        assert isinstance(resource, ParsedMediaResource)
        assert resource.provider == MediaProvider.YOUTUBE
        assert resource.media_type == MediaType.VIDEO
        assert resource.resource_id == expected_resource_id
        assert resource.embed_url == expected_embed_url

        # Гарантия отсутствия параметров таймкода и трекинга во фрейме встраивания
        assert "t=" not in resource.embed_url
        assert "feature=" not in resource.embed_url


@pytest.mark.unit
def test_parse_vk_valid_urls() -> None:
    """
    Проверка корректного распознавания и парсинга ссылок VK Video:
    стандартных видео vk.com, vkvideo.ru, видео пользователей с положительным id,
    а также ссылок видеоплеера video_ext.php с сохранением параметра hash.
    """
    # 1. Видео сообщества с отрицательным идентификатором владельца
    res_community = parse_media_url("https://vk.com/video-22822305_456239018")
    assert isinstance(res_community, ParsedMediaResource)
    assert res_community.provider == MediaProvider.VK
    assert res_community.media_type == MediaType.VIDEO
    assert res_community.resource_id == "-22822305_456239018"
    assert res_community.embed_url == "https://vk.com/video_ext.php?oid=-22822305&id=456239018"

    # 2. Домен vkvideo.ru
    res_vkvideo = parse_media_url("https://vkvideo.ru/video-22822305_456239018")
    assert res_vkvideo.provider == MediaProvider.VK
    assert res_vkvideo.resource_id == "-22822305_456239018"
    assert res_vkvideo.embed_url == "https://vk.com/video_ext.php?oid=-22822305&id=456239018"

    # 3. Видео пользователя с положительным идентификатором владельца
    res_user = parse_media_url("https://www.vkvideo.ru/video12345_67890")
    assert res_user.provider == MediaProvider.VK
    assert res_user.resource_id == "12345_67890"
    assert res_user.embed_url == "https://vk.com/video_ext.php?oid=12345&id=67890"

    # 4. Формат встраиваемого виджета с параметром hash
    res_widget = parse_media_url(
        "https://vk.com/video_ext.php?oid=-22822305&id=456239018&hash=abcdef1234"
    )
    assert res_widget.provider == MediaProvider.VK
    assert res_widget.resource_id == "-22822305_456239018"
    assert "oid=-22822305" in res_widget.embed_url
    assert "id=456239018" in res_widget.embed_url
    assert "hash=abcdef1234" in res_widget.embed_url


@pytest.mark.unit
def test_parse_rutube_valid_urls() -> None:
    """
    Проверка корректного распознавания и парсинга ссылок Rutube:
    стандартных страниц просмотра и встраиваемого плеера play/embed.
    Убеждается в нормализации 32-значного шестнадцатеричного идентификатора к нижнему регистру.
    """
    test_id = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
    expected_embed = f"https://rutube.ru/play/embed/{test_id}"

    # Стандартная страница просмотра
    res_std = parse_media_url(f"https://rutube.ru/video/{test_id}/")
    assert isinstance(res_std, ParsedMediaResource)
    assert res_std.provider == MediaProvider.RUTUBE
    assert res_std.media_type == MediaType.VIDEO
    assert res_std.resource_id == test_id
    assert res_std.embed_url == expected_embed

    # Плеер встраивания
    res_embed = parse_media_url(f"https://rutube.ru/play/embed/{test_id}")
    assert res_embed.provider == MediaProvider.RUTUBE
    assert res_embed.resource_id == test_id
    assert res_embed.embed_url == expected_embed

    # Проверка нечувствительности к верхнему регистру в шестнадцатеричном идентификаторе
    upper_id = test_id.upper()
    res_upper = parse_media_url(f"https://rutube.ru/video/{upper_id}/")
    assert res_upper.resource_id == test_id
    assert res_upper.embed_url == expected_embed


@pytest.mark.unit
def test_parse_yandex_valid_urls() -> None:
    """
    Проверка корректного парсинга ссылок сервиса Яндекс.Музыка:
    отдельных треков внутри альбома и альбомов целиком.
    Убеждается в формировании канонических адресов iframe-виджетов.
    """
    # 1. Трек внутри альбома
    track_url = "https://music.yandex.ru/album/12345/track/67890"
    res_track = parse_media_url(track_url)
    assert isinstance(res_track, ParsedMediaResource)
    assert res_track.provider == MediaProvider.YANDEX
    assert res_track.media_type == MediaType.AUDIO
    assert res_track.embed_url == "https://music.yandex.ru/iframe/#track/67890/12345"
    assert "67890" in str(res_track.resource_id)

    # 2. Отдельный альбом
    album_url = "https://music.yandex.ru/album/12345"
    res_album = parse_media_url(album_url)
    assert res_album.provider == MediaProvider.YANDEX
    assert res_album.media_type == MediaType.AUDIO
    assert res_album.embed_url == "https://music.yandex.ru/iframe/#album/12345"
    assert "12345" in str(res_album.resource_id)


@pytest.mark.unit
def test_parse_direct_audio_valid_urls() -> None:
    """
    Проверка корректной обработки прямых HTTPS-ссылок на аудиофайлы
    для всех регламентированных расширений из DIRECT_AUDIO_EXTENSIONS (.mp3, .ogg, .m4a, .wav, .opus).
    Убеждается в сохранении токенов запроса, а также в значениях embed_url=None и resource_id=None.
    """
    for ext in DIRECT_AUDIO_EXTENSIONS:
        audio_url = f"https://cdn.example.org/audio/lecture{ext}"
        assert is_direct_audio_url(audio_url) is True

        res = parse_media_url(audio_url)
        assert isinstance(res, ParsedMediaResource)
        assert res.provider == MediaProvider.DIRECT
        assert res.media_type == MediaType.AUDIO
        assert res.resource_id is None
        assert res.embed_url is None

    # Проверка ссылки с авторизационными токенами и временными фрагментами
    complex_audio_url = "https://cdn.example.org/audio/lecture.mp3?token=secret#t=10"
    assert is_direct_audio_url(complex_audio_url) is True

    res_complex = parse_media_url(complex_audio_url)
    assert res_complex.provider == MediaProvider.DIRECT
    assert res_complex.media_type == MediaType.AUDIO
    assert res_complex.embed_url is None
    assert res_complex.resource_id is None


@pytest.mark.unit
def test_reject_spoofed_and_untrusted_hosts() -> None:
    """
    Проверка блокировки поддельных, фишинговых и недоверенных доменных имен
    с префиксными и суффиксными манипуляциями.
    Гарантирует возбуждение UnsupportedMediaProviderError.
    """
    spoofed_urls = [
        "https://evilyoutube.com/watch?v=dQw4w9WgXcQ",
        "https://youtube.com.attacker.com/watch?v=dQw4w9WgXcQ",
        "https://fake-rutube.ru/video/12345678901234567890123456789012",
        "https://vk.com.phishing.org/video1_2",
        "https://music.yandex.ru.evil.com/album/1",
    ]

    for url in spoofed_urls:
        with pytest.raises(UnsupportedMediaProviderError):
            parse_media_url(url)


@pytest.mark.unit
def test_reject_unsupported_schemes() -> None:
    """
    Проверка отклонения потенциально опасных псевдопротоколов (javascript, data, vbscript),
    неподдерживаемых сетевых схем (ftp, file) и незащищенного протокола HTTP для прямых аудиофайлов.
    """
    dangerous_urls = [
        "javascript:alert(1)",
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        "vbscript:msgbox(1)",
        "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
        "file:///etc/passwd",
        "http://cdn.example.org/audio.mp3",
    ]

    for url in dangerous_urls:
        with pytest.raises((UnsupportedMediaProviderError, InvalidMediaUrlError, MediaParserError)):
            parse_media_url(url)


@pytest.mark.unit
def test_normalize_userinfo_and_ports() -> None:
    """
    Проверка безопасной очистки учетных данных (userinfo) и нормализации портов в URL.
    Убеждается, что ссылка с учетными данными распознается по целевому хосту,
    а хост со стандартным портом успешно сопоставляется с доверенным провайдером.
    """
    # Ссылка с внедренными учетными данными очищается и парсится как YouTube
    userinfo_url = "https://user:password@www.youtube.com/watch?v=dQw4w9WgXcQ"
    res_yt = parse_media_url(userinfo_url)
    assert res_yt.provider == MediaProvider.YOUTUBE
    assert res_yt.resource_id == "dQw4w9WgXcQ"

    # Хост с явным указанием порта :443 сопоставляется с Rutube
    rutube_port_url = "https://rutube.ru:443/video/a1b2c3d4e5f60718293a4b5c6d7e8f90/"
    res_rutube = parse_media_url(rutube_port_url)
    assert res_rutube.provider == MediaProvider.RUTUBE
    assert res_rutube.resource_id == "a1b2c3d4e5f60718293a4b5c6d7e8f90"

    # Проверка вспомогательных функций нормализации и сопоставления
    assert match_provider_by_host(normalize_url_host("rutube.ru:443")) == MediaProvider.RUTUBE
    assert (
        match_provider_by_host(normalize_url_host("user:pass@youtube.com")) == MediaProvider.YOUTUBE
    )


@pytest.mark.unit
def test_reject_invalid_resource_identifiers() -> None:
    """
    Проверка строгой валидации идентификаторов медиа-ресурсов.
    Блокирует идентификаторы некорректной длины, содержащие спецсимволы,
    а также нечисловые значения в параметрах маршрутов.
    """
    invalid_identifier_urls = [
        # YouTube: идентификатор длиной 10 символов вместо 11
        "https://www.youtube.com/watch?v=dQw4w9WgXc",
        # YouTube: идентификатор длиной более 11 символов
        "https://www.youtube.com/watch?v=dQw4w9WgXcQextra",
        # YouTube: недопустимый спецсимвол в идентификаторе
        "https://www.youtube.com/watch?v=dQw4w9WgXc!",
        # Rutube: идентификатор длиной 31 символ вместо 32
        "https://rutube.ru/video/a1b2c3d4e5f60718293a4b5c6d7e8f9/",
        # Rutube: идентификатор длиной более 32 символов
        "https://rutube.ru/video/a1b2c3d4e5f60718293a4b5c6d7e8f901/",
        # Rutube: не шестнадцатеричный символ 'g'
        "https://rutube.ru/video/g1b2c3d4e5f60718293a4b5c6d7e8f90/",
        # VK: нечисловые идентификаторы в пути
        "https://vk.com/video-abc_def",
        # VK: нечисловой oid в параметрах виджета
        "https://vk.com/video_ext.php?oid=invalid&id=456",
        # Яндекс: нечисловой идентификатор альбома
        "https://music.yandex.ru/album/abc",
        # Яндекс: нечисловой идентификатор трека
        "https://music.yandex.ru/album/123/track/xyz",
    ]

    for url in invalid_identifier_urls:
        with pytest.raises(InvalidMediaUrlError):
            parse_media_url(url)


@pytest.mark.unit
def test_reject_malformed_and_control_characters() -> None:
    """
    Проверка реакции парсера на дефектные входные данные, отсутствие сетевой схемы,
    управляющие символы и нулевые байты.
    """
    malformed_inputs = [
        "",
        "   ",
        "youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=dQw4w\09WgXcQ",
        "https://www.youtube.com/watch?v=dQw4w\r\n9WgXcQ",
        "https://rutube.ru/video/a1b2c3\x00d4e5f60718293a4b5c6d7e8f90/",
    ]

    for malformed in malformed_inputs:
        with pytest.raises(InvalidMediaUrlError):
            parse_media_url(malformed)


@pytest.mark.unit
def test_normalize_idn_domains() -> None:
    """
    Проверка функции нормализации доменных имен normalize_url_host
    на поддержку интернационализированных доменов (IDN / Punycode) и приведение к нижнему регистру.
    """
    # Приведение к нижнему регистру и отсечение пробелов
    assert normalize_url_host("  WWW.YOUTUBE.COM  ") == "www.youtube.com"

    # Отсечение портов и учетных данных пользователя
    assert normalize_url_host("user:pass@Rutube.Ru:8080") == "rutube.ru"

    # Поддержка интернационализированных доменов (IDN)
    idn_host = normalize_url_host("видео.ру")
    assert idn_host.startswith("xn--") or idn_host == "видео.ру"

    # Поддержка предварительно закодированного Punycode
    punycode_host = normalize_url_host("xn--b1agpe9ac.xn--p1ai")
    assert "xn--" in punycode_host


@pytest.mark.unit
def test_media_parser_exception_hierarchy() -> None:
    """
    Проверка иерархии исключений модуля media_parser.
    Убеждается, что все специализированные ошибки наследуются от базового класса MediaParserError.
    """
    assert issubclass(UnsupportedMediaProviderError, MediaParserError)
    assert issubclass(InvalidMediaUrlError, MediaParserError)
