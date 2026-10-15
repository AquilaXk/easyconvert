#!/usr/bin/env python3
"""Renders the clean pages of the OCR confidence calibration sets from known text.

Ground truth is the text drawn onto each page, so no label comes from the recognizer. The set
holds four English and four Korean paragraphs, rendered once at 300 dpi. The test and the fitting
tool (tests/helpers/fit-ocr-calibration.mts) degrade them with a seeded sampler
(tests/helpers/ocr-degrade.ts): pages a and b fit the calibration tables, pages c and d are the
held-out half that the expected calibration error is measured on.

    python3 tests/fixtures/ocr-calibration/generate_calibration.py

Requires Pillow plus the Liberation Serif and WenQuanYi Zen Hei fonts. Output is deterministic.
The paragraphs are the project's own text.
"""
import os

from PIL import Image, ImageDraw, ImageFont

ENGLISH_FONT_PATH = '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'
KOREAN_FONT_PATH = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
RENDER_DPI = 300
ENGLISH_FONT_PT = 11
KOREAN_FONT_PT = 14
ENGLISH_PAGE_W = 1700
# Korean is laid out reliably only on pages with several lines, so its pages are narrower.
KOREAN_PAGE_W = 1300
MARGIN = 80
LINE_SPACING = 1.4

ENGLISH = {
    'en_a': (
        "The harbour authority published its annual review of vessel traffic on Tuesday. Container "
        "arrivals rose by eight percent compared with the previous year, while passenger sailings "
        "declined slightly because of two cancelled routes. Engineers inspected the northern quay in "
        "March and recommended replacing eleven of the older fenders before the winter storms begin. "
        "Funding for the work will come from a fee on cargo above 4,000 tonnes. The council will vote on the proposal in September, and residents may send written comments until the first of that month."
    ),
    'en_b': (
        "Applicants must submit the completed form, two photographs and a certified copy of their "
        "diploma by the end of the month. Late submissions are not accepted unless a physician's note "
        "is attached. Interviews take place in Room 214 between 9:30 and 16:00, and each candidate "
        "will be told the result by email within ten working days. Questions go to the registrar. Candidates who do not receive a reply should telephone the office on Monday morning, quoting the reference number printed on the form."
    ),
    'en_c': (
        "Samples of river water were collected at six stations during the spring flood. The mean "
        "concentration of dissolved oxygen was 8.4 milligrams per litre, well above the legal "
        "minimum, although the station below the paper mill recorded only 5.1. Researchers suspect "
        "that warm discharge reduces the oxygen available to fish, and they plan further tests in "
        "August when the flow is lowest. The final report, with maps of every station and a table of temperatures, will be published online by the end of the year."
    ),
    'en_d': (
        "Version 2.6 of the scheduling software adds a calendar view, faster exports and support for "
        "recurring tasks. Administrators can now assign permissions to groups instead of individual "
        "users, which removes about forty clicks from the weekly routine. The installer keeps all "
        "existing settings, but a backup is recommended before upgrading from any build older than "
        "2.1. Support for older operating systems ends with this release, so customers on those systems should read the migration guide first."
    ),
    'en_e': (
        "The museum reopens on Saturday after a two year renovation. Visitors will find the old "
        "textile hall restored, a new reading room on the second floor and a cafe that serves "
        "lunch until 15:00. Tickets cost 12 euros for adults and are free for children under "
        "twelve. Guided tours in three languages start every hour, and groups of more than "
        "twenty people should book at least a week ahead."
    ),
    'en_f': (
        "A mild winter helped the orchard owners, who expect the harvest of apples and pears to "
        "reach 3,200 tonnes this autumn. Buyers have already signed contracts for roughly half of "
        "it, mostly with juice makers in the north. Growers warn, however, that a shortage of "
        "seasonal workers could delay picking by several days unless the labour office approves "
        "the extra permits requested in June."
    ),
}
KOREAN = {
    'ko_a': (
        "항만청은 화요일에 선박 통행량에 대한 연례 보고서를 발표했다. 컨테이너 입항은 전년보다 "
        "팔 퍼센트 늘었으나 두 개 노선이 취소되어 여객 운항은 소폭 줄었다. 기술자들은 삼월에 "
        "북쪽 부두를 점검했으며 겨울 폭풍이 오기 전에 오래된 방현재 열한 개를 교체하라고 권고했다. "
        "공사 비용은 사천 톤을 넘는 화물에 부과하는 수수료로 마련할 예정이다. 시의회는 구월에 이 안건을 표결할 예정이며 주민은 그달 초하루까지 서면으로 의견을 보낼 수 있다. 접수된 의견은 모두 회의록에 첨부하여 공개한다."
    ),
    'ko_b': (
        "지원자는 이달 말까지 작성한 신청서와 사진 두 장 그리고 졸업장 사본을 제출해야 한다. "
        "의사의 소견서가 없으면 늦게 낸 서류는 받지 않는다. 면접은 이백십사 호실에서 오전 아홉 시 "
        "삼십 분부터 오후 네 시까지 진행하며 결과는 영업일 기준 열흘 안에 이메일로 알려 드린다. "
        "문의 사항은 학적과로 보내 주시기 바랍니다. 답변을 받지 못한 지원자는 월요일 아침에 사무실로 전화하여 신청서에 인쇄된 접수 번호를 말해야 한다. 서류는 심사가 끝난 뒤에도 돌려드리지 않습니다."
    ),
    'ko_c': (
        "봄 홍수 기간에 여섯 개 지점에서 하천수 시료를 채취했다. 용존 산소의 평균 농도는 리터당 "
        "8.4밀리그램으로 법정 기준을 크게 웃돌았지만 제지 공장 아래쪽 지점은 5.1에 그쳤다. "
        "연구진은 따뜻한 배출수가 물고기가 쓸 수 있는 산소를 줄인다고 보고 유량이 가장 적은 "
        "팔월에 추가 시험을 하기로 했다. 모든 지점의 지도와 수온 표를 담은 최종 보고서는 올해 말까지 인터넷에 공개할 계획이다. 시료 보관 상태에 대한 점검 결과도 함께 실을 예정이다."
    ),
    'ko_d': (
        "일정 관리 프로그램 2.6 버전에는 달력 보기와 빠른 내보내기 그리고 반복 작업 기능이 "
        "추가되었다. 관리자는 이제 개별 사용자 대신 그룹에 권한을 줄 수 있어 매주 하던 작업에서 "
        "마흔 번쯤 클릭을 줄일 수 있다. 설치 프로그램은 기존 설정을 모두 유지하지만 2.1보다 "
        "오래된 빌드에서 올릴 때에는 먼저 백업하기를 권한다. 이번 버전부터 오래된 운영체제는 지원하지 않으므로 해당 체제를 쓰는 고객은 먼저 이전 안내서를 읽어 보아야 한다. 안내서는 누리집에서 내려받을 수 있다."
    ),
    'ko_e': (
        "박물관은 이 년간의 보수 공사를 마치고 토요일에 다시 문을 연다. 방문객은 옛 직물 전시관이 "
        "복원된 모습과 이 층에 새로 생긴 열람실 그리고 오후 세 시까지 점심을 파는 식당을 만날 수 "
        "있다. 입장권은 어른 열두 유로이며 열두 살 미만 어린이는 무료이다. 세 개 언어로 하는 안내 "
        "관람은 매시간 시작하고 스무 명이 넘는 단체는 적어도 한 주 전에 예약해야 한다."
    ),
    'ko_f': (
        "포근한 겨울 덕분에 과수원 주인들은 올가을 사과와 배 수확량이 삼천이백 톤에 이를 것으로 "
        "기대한다. 구매자들은 이미 물량의 절반가량을 계약했으며 대부분 북쪽 지역의 주스 제조업체이다. "
        "그러나 재배 농가는 노동청이 유월에 신청한 추가 허가를 내주지 않으면 계절 노동자가 모자라 "
        "수확이 며칠 늦어질 수 있다고 경고했다."
    ),
}


def wrap(draw, text, font, max_width, by_character):
    """Breaks at spaces, so a word is never split across lines; returns the lines."""
    lines, current = [], ''
    units = list(text) if by_character else text.split()
    for unit in units:
        candidate = current + unit if by_character else (current + ' ' + unit).strip()
        if draw.textlength(candidate, font=font) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = unit
    lines.append(current)
    return lines


def render(text, font_path, font_pt, by_character, page_w):
    font = ImageFont.truetype(font_path, int(round(font_pt * RENDER_DPI / 72)))
    measure = ImageDraw.Draw(Image.new('L', (1, 1)))
    lines = wrap(measure, text, font, page_w - 2 * MARGIN, by_character)
    line_height = int(font.size * LINE_SPACING)
    img = Image.new('L', (page_w, 2 * MARGIN + len(lines) * line_height), 255)
    draw = ImageDraw.Draw(img)
    for index, line in enumerate(lines):
        draw.text((MARGIN, MARGIN + index * line_height), line.strip(), font=font, fill=0)
    return img


def main():
    out = os.path.dirname(os.path.abspath(__file__))
    for pages, font_path, font_pt, by_character, page_w in (
        (ENGLISH, ENGLISH_FONT_PATH, ENGLISH_FONT_PT, False, ENGLISH_PAGE_W),
        (KOREAN, KOREAN_FONT_PATH, KOREAN_FONT_PT, False, KOREAN_PAGE_W),
    ):
        for name, text in pages.items():
            with open(os.path.join(out, f'{name}.gt.txt'), 'w') as fh:
                fh.write(text + '\n')
            render(text, font_path, font_pt, by_character, page_w).save(
                os.path.join(out, f'{name}.png'), dpi=(RENDER_DPI, RENDER_DPI), optimize=True
            )


if __name__ == '__main__':
    main()
