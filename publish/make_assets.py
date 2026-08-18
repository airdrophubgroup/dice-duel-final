"""
make_assets.py — Pure-Python (stdlib only) PNG generator for the
Worldcoin Developer Portal listing assets. No PIL / no canvas needed.

Outputs (into ./publish):
  app-icon.png          512x512  square, non-white bg
  content-card.png      1035x720 (345x240 @3x), NO text, bottom 282px clear
  screenshot-home.png   390x844  home screen
  screenshot-game.png   390x844  in-game screen
  screenshot-result.png 390x844  victory screen
  screenshot-bot.png    390x844  support bot screen
"""
import zlib, struct, math, os

# ---------------- minimal PNG writer (RGB, filter 0) ----------------
def write_png(path, w, h, pixels):
    # pixels: list of rows; each row = list of (r,g,b)
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for (r, g, b) in row:
            raw.append(r); raw.append(g); raw.append(b)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
        return c
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

# ---------------- drawing helpers ----------------
def lerp(a, b, t):
    return a + (b - a) * t

def clamp255(v):
    return max(0, min(255, int(round(v))))

def blend(base, top, alpha):
    return tuple(clamp255(lerp(base[i], top[i], alpha)) for i in range(3))

class Canvas:
    def __init__(self, w, h):
        self.w = w; self.h = h
        self.px = [[(0, 0, 0)] * w for _ in range(h)]
    def set(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = color
    def fill(self, color):
        for y in range(self.h):
            for x in range(self.w):
                self.px[y][x] = color
    def vgrad(self, c_top, c_bot):
        for y in range(self.h):
            t = y / max(1, self.h - 1)
            c = tuple(clamp255(lerp(c_top[i], c_bot[i], t)) for i in range(3))
            for x in range(self.w):
                self.px[y][x] = c
    def hgrad(self, c_left, c_right):
        for y in range(self.h):
            for x in range(self.w):
                t = x / max(1, self.w - 1)
                self.px[y][x] = tuple(clamp255(lerp(c_left[i], c_right[i], t)) for i in range(3))
    def rect(self, x0, y0, x1, y1, color):
        for y in range(max(0, y0), min(self.h, y1)):
            for x in range(max(0, x0), min(self.w, x1)):
                self.px[y][x] = color
    def rrect(self, x0, y0, x1, y1, rad, color):
        rad = min(rad, (x1 - x0) // 2, (y1 - y0) // 2)
        for y in range(max(0, y0), min(self.h, y1)):
            for x in range(max(0, x0), min(self.w, x1)):
                # inside corner rounding test
                cx = max(x0 + rad, min(x, x1 - rad - 1))
                cy = max(y0 + rad, min(y, y1 - rad - 1))
                if (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad + rad:
                    self.px[y][x] = color
                elif x0 + rad <= x < x1 - rad or y0 + rad <= y < y1 - rad:
                    self.px[y][x] = color
    def circle(self, cx, cy, rad, color):
        rad2 = rad * rad
        for y in range(int(cy - rad) - 1, int(cy + rad) + 2):
            for x in range(int(cx - rad) - 1, int(cx + rad) + 2):
                if (x - cx) ** 2 + (y - cy) ** 2 <= rad2:
                    self.set(x, y, color)
    def circle_shadow(self, cx, cy, rad, color, glow):
        rad2 = rad * rad
        for y in range(int(cy - rad) - glow, int(cy + rad) + glow + 1):
            for x in range(int(cx - rad) - glow, int(cx + rad) + glow + 1):
                d2 = (x - cx) ** 2 + (y - cy) ** 2
                if d2 <= rad2:
                    self.set(x, y, color)
                elif d2 <= (rad + glow) ** 2:
                    t = (d2 - rad2) / ((rad + glow) ** 2 - rad2)
                    cur = self.px[y][x]
                    self.px[y][x] = blend(cur, color, max(0, 1 - t))
    def line(self, x0, y0, x1, y1, color, width=1):
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for i in range(steps + 1):
            t = i / steps
            x = round(lerp(x0, x1, t)); y = round(lerp(y0, y1, t))
            for dx in range(-(width // 2), width // 2 + 1):
                for dy in range(-(width // 2), width // 2 + 1):
                    self.set(x + dx, y + dy, color)
    # tiny 5x7 bitmap font (caps + digits + some symbols)
    FONT = {
        'A': ["01110","10001","10001","11111","10001","10001","10001"],
        'B': ["11110","10001","10001","11110","10001","10001","11110"],
        'C': ["01111","10000","10000","10000","10000","10000","01111"],
        'D': ["11110","10001","10001","10001","10001","10001","11110"],
        'E': ["11111","10000","10000","11110","10000","10000","11111"],
        'F': ["11111","10000","10000","11110","10000","10000","10000"],
        'G': ["01111","10000","10000","10111","10001","10001","01111"],
        'H': ["10001","10001","10001","11111","10001","10001","10001"],
        'I': ["11111","00100","00100","00100","00100","00100","11111"],
        'J': ["00111","00010","00010","00010","00010","10010","01100"],
        'K': ["10001","10010","10100","11000","10100","10010","10001"],
        'L': ["10000","10000","10000","10000","10000","10000","11111"],
        'M': ["10001","11011","10101","10101","10001","10001","10001"],
        'N': ["10001","11001","10101","10011","10001","10001","10001"],
        'O': ["01110","10001","10001","10001","10001","10001","01110"],
        'P': ["11110","10001","10001","11110","10000","10000","10000"],
        'Q': ["01110","10001","10001","10001","10101","10010","01101"],
        'R': ["11110","10001","10001","11110","10100","10010","10001"],
        'S': ["01111","10000","10000","01110","00001","00001","11110"],
        'T': ["11111","00100","00100","00100","00100","00100","00100"],
        'U': ["10001","10001","10001","10001","10001","10001","01110"],
        'V': ["10001","10001","10001","10001","10001","01010","00100"],
        'W': ["10001","10001","10001","10101","10101","10101","01010"],
        'X': ["10001","10001","01010","00100","01010","10001","10001"],
        'Y': ["10001","10001","01010","00100","00100","00100","00100"],
        'Z': ["11111","00001","00010","00100","01000","10000","11111"],
        '0': ["01110","10001","10011","10101","11001","10001","01110"],
        '1': ["00100","01100","00100","00100","00100","00100","01110"],
        '2': ["01110","10001","00001","00010","00100","01000","11111"],
        '3': ["11110","00001","00001","01110","00001","00001","11110"],
        '4': ["00010","00110","01010","10010","11111","00010","00010"],
        '5': ["11111","10000","10000","11110","00001","00001","11110"],
        '6': ["01110","10000","10000","11110","10001","10001","01110"],
        '7': ["11111","00001","00010","00100","01000","01000","01000"],
        '8': ["01110","10001","10001","01110","10001","10001","01110"],
        '9': ["01110","10001","10001","01111","00001","00001","01110"],
        '-': ["00000","00000","00000","11111","00000","00000","00000"],
        '_': ["00000","00000","00000","00000","00000","00000","11111"],
        '.': ["00000","00000","00000","00000","00000","00000","00100"],
        ':': ["00000","00100","00100","00000","00100","00100","00000"],
        '+': ["00000","00100","00100","11111","00100","00100","00000"],
        '/': ["00001","00010","00010","00100","01000","01000","10000"],
        ' ': ["00000","00000","00000","00000","00000","00000","00000"],
        '!': ["00100","00100","00100","00100","00100","00000","00100"],
        '?': ["01110","10001","00001","00010","00100","00000","00100"],
        '>': ["10000","01000","00100","00010","00100","01000","10000"],
        '<': ["00001","00010","00100","01000","00100","00010","00001"],
        '[': ["01110","01000","01000","01000","01000","01000","01110"],
        ']': ["01110","00010","00010","00010","00010","00010","01110"],
        '@': ["01110","10001","10001","10101","10101","10000","01110"],
        '&': ["01100","10010","10010","01100","10010","10010","01101"],
        'W0': ["10001","10001","10001","10101","10101","10101","01010"],
    }
    def text(self, x, y, s, scale, color):
        cx = x
        for ch in s.upper():
            glyph = self.FONT.get(ch)
            if not glyph:
                cx += 4 * scale; continue
            for row_i, row in enumerate(glyph):
                for col_i, bit in enumerate(row):
                    if bit == '1':
                        for dy in range(scale):
                            for dx in range(scale):
                                self.set(cx + col_i * scale + dx, y + row_i * scale + dy, color)
            cx += 6 * scale
        return cx

TEAL = (41, 217, 194)
GOLD = (255, 179, 0)
DARK = (10, 12, 26)
BONE = (241, 238, 230)
SLATE = (139, 139, 163)
SIGNAL = (255, 95, 109)

# ================= 1. APP ICON 512x512 =================
def make_icon():
    W = H = 512
    c = Canvas(W, H)
    # bg gradient (dark navy -> teal-tinted -> violet)
    for y in range(H):
        t = y / (H - 1)
        if t < 0.55:
            t2 = t / 0.55
            col = tuple(clamp255(lerp(a, b, t2)) for a, b in zip((11, 16, 38), (10, 26, 30)))
        else:
            t2 = (t - 0.55) / 0.45
            col = tuple(clamp255(lerp(a, b, t2)) for a, b in zip((10, 26, 30), (16, 20, 46)))
        for x in range(W):
            c.px[y][x] = col
    # subtle grid (clamp to canvas bounds)
    for i in range(9):
        p = i * 64
        if p < W:
            for y in range(H):
                c.px[y][p] = blend(c.px[y][p], TEAL, 0.05)
        if p < H:
            for x in range(W):
                c.px[p][x] = blend(c.px[p][x], TEAL, 0.05)
    # glow behind cube
    c.circle_shadow(256, 252, 120, (10, 30, 26), 90)
    # dice cube body
    cx, cy, size, rad = 256, 258, 210, 42
    x0, y0 = cx - size // 2, cy - size // 2
    # gradient body
    for y in range(y0, y0 + size):
        t = (y - y0) / size
        col = tuple(clamp255(lerp(a, b, t)) for a, b in zip((31, 143, 134), (126, 232, 216)))
        for x in range(x0, x0 + size):
            # rounded corner test
            rx = max(x0 + rad, min(x, x0 + size - rad - 1))
            ry = max(y0 + rad, min(y, y0 + size - rad - 1))
            inside = ((x - rx) ** 2 + (y - ry) ** 2 <= rad * rad + rad) or (x0 + rad <= x < x0 + size - rad or y0 + rad <= y < y0 + size - rad)
            if inside:
                c.px[y][x] = col
    # white inner border
    for y in range(y0 - 3, y0 + size + 3):
        for x in range(x0 - 3, x0 + size + 3):
            rx = max(x0 + rad, min(x, x0 + size - rad - 1))
            ry = max(y0 + rad, min(y, y0 + size - rad - 1))
            core = ((x - rx) ** 2 + (y - ry) ** 2 <= rad * rad + rad) or (x0 + rad <= x < x0 + size - rad or y0 + rad <= y < y0 + size - rad)
            if not core:
                c.set(x, y, (255, 255, 255))
    # pips (face 5)
    half = size // 2 - 30
    pr = 20
    for (px, py) in [(cx - half, cy - half), (cx + half, cy - half), (cx, cy), (cx - half, cy + half), (cx + half, cy + half)]:
        c.circle_shadow(px, py, pr, (6, 34, 42), 6)
    # wordmark (spaced so lines don't overlap)
    c.text(256 - 90, 434, "TNV", 9, TEAL)
    c.text(256 - 110, 492, "DUEL ARENA", 4, (200, 255, 248))
    write_png(os.path.join(DIR, "app-icon.png"), W, H, c.px)
    print("app-icon.png", W, "x", H)

# ================= 2. CONTENT CARD 1035x720 (no text, bottom clear) =================
def make_card():
    W, H = 1035, 720
    c = Canvas(W, H)
    for y in range(H):
        t = y / (H - 1)
        col = tuple(clamp255(lerp(a, b, t)) for a, b in zip((11, 16, 38), (16, 20, 46)))
        for x in range(W):
            c.px[y][x] = col
    # diagonal beam (upper area only, keep bottom 282px clean)
    for y in range(0, H - 282):
        for x in range(W):
            d = (x / W) + (y / (H - 282)) * 0.5
            alpha = 0.22 * max(0, 1 - d)
            c.px[y][x] = blend(c.px[y][x], TEAL, alpha)
    # floating dice
    def die(cx, cy, s, rot, alpha):
        # rotate via simple approximation: draw axis-aligned with slight offsets
        for y in range(cy - s // 2, cy + s // 2):
            for x in range(cx - s // 2, cx + s // 2):
                # translate for rotation
                dx = x - cx; dy = y - cy
                nx = dx * math.cos(-rot) - dy * math.sin(-rot)
                ny = dx * math.sin(-rot) + dy * math.cos(-rot)
                if abs(nx) <= s // 2 and abs(ny) <= s // 2:
                    t = (ny + s // 2) / s
                    col = tuple(clamp255(lerp(a, b, t)) for a, b in zip((45, 212, 192), (126, 232, 216)))
                    cur = c.px[y][x]
                    c.px[y][x] = blend(cur, col, alpha)
        # pips on rotated die (approximate)
        pr = max(6, s // 12)
        h = s // 2 - s // 6
        for (ox, oy) in [(-h, -h), (h, -h), (0, 0), (-h, h), (h, h)]:
            px = cx + ox; py = cy + oy
            for y in range(py - pr, py + pr):
                for x in range(px - pr, px + pr):
                    if (x - px) ** 2 + (y - py) ** 2 <= pr * pr:
                        cur = c.px[y][x]
                        c.px[y][x] = blend(cur, (6, 34, 42), alpha)
    die(210, 260, 180, 0.18, 0.95)
    die(900, 320, 130, -0.22, 0.9)
    die(570, 180, 90, -0.35, 0.85)
    die(720, 560, 110, 0.3, 0.85)
    # coins
    def coin(cx, cy, rad):
        c.circle_shadow(cx, cy, rad, GOLD, 10)
        for y in range(cy - rad, cy + rad):
            for x in range(cx - rad, cx + rad):
                if (x - cx) ** 2 + (y - cy) ** 2 <= (rad - 4) ** 2:
                    c.px[y][x] = (92, 61, 0)
    # coins kept ABOVE the bottom 282px overlay zone (y < 438)
    coin(150, 400, 40)
    coin(930, 380, 32)
    coin(420, 420, 26)
    write_png(os.path.join(DIR, "content-card.png"), W, H, c.px)
    print("content-card.png", W, "x", H)

# ================= 3. PHONE SCREENSHOTS 390x844 =================
PHONE_W, PHONE_H = 390, 844

def phone_base():
    c = Canvas(PHONE_W, PHONE_H)
    c.vgrad((11, 16, 38), (16, 20, 46))
    # top status bar
    c.rect(0, 0, PHONE_W, 34, (8, 10, 22))
    c.text(20, 10, "9:41", 2, BONE)
    # support + chat buttons
    c.rrect(14, 48, 120, 76, 12, (30, 34, 58))
    c.text(22, 56, "SUPPORT", 2, BONE)
    c.rrect(PHONE_W - 160, 48, PHONE_W - 14, 76, 12, (30, 34, 58))
    c.text(PHONE_W - 150, 56, "GLOBAL CHAT", 2, BONE)
    # balance card
    c.rrect(20, 96, PHONE_W - 20, 240, 22, (17, 22, 44))
    c.text(36, 116, "TNV BALANCE", 2, SLATE)
    c.text(36, 142, "523", 6, TEAL)
    c.text(36, 190, "WLD BALANCE", 2, SLATE)
    c.text(36, 214, "100.00", 4, GOLD)
    # dice (center)
    cx, cy = PHONE_W // 2, 380
    c.circle_shadow(cx, cy, 44, (45, 212, 192), 20)
    pr = 7
    for (ox, oy) in [(-22, -22), (22, -22), (0, 0), (-22, 22), (22, 22)]:
        c.circle(cx + ox, cy + oy, pr, (6, 34, 42))
    # fee chips
    c.text(20, 470, "CHOOSE YOUR DUEL FEE", 2, SLATE)
    c.rrect(20, 496, 132, 540, 14, (24, 28, 54))
    c.text(34, 512, "0.5 WLD", 3, TEAL)
    c.rrect(146, 496, 258, 540, 14, (24, 28, 54))
    c.text(160, 512, "1 WLD", 3, BONE)
    c.rrect(272, 496, 384, 540, 14, (24, 28, 54))
    c.text(286, 512, "2 WLD", 3, BONE)
    # PLAY button
    c.rrect(40, 566, PHONE_W - 40, 620, 16, TEAL)
    c.text(PHONE_W // 2 - 60, 582, "PLAY NOW (0.5 WLD)", 3, (4, 18, 14))
    # nav buttons
    c.rrect(20, 648, PHONE_W - 20, 700, 14, (17, 22, 44))
    c.text(34, 662, "MATCH HISTORY", 2, BONE)
    c.rrect(20, 712, PHONE_W - 20, 764, 14, (17, 22, 44))
    c.text(34, 726, "MY WITHDRAWALS", 2, BONE)
    # bottom bar
    c.rect(0, PHONE_H - 60, PHONE_W, PHONE_H, (8, 10, 22))
    return c

def make_home():
    c = phone_base()
    write_png(os.path.join(DIR, "screenshot-home.png"), PHONE_W, PHONE_H, c.px)
    print("screenshot-home.png", PHONE_W, "x", PHONE_H)

def make_game():
    c = phone_base()
    # overlay game screen: score boxes top, big die, timer
    c.rect(0, 0, PHONE_W, PHONE_H, (9, 12, 26))
    # score row
    c.rrect(16, 60, 150, 130, 16, (20, 24, 48))
    c.text(28, 74, "ME", 3, TEAL)
    c.text(28, 98, "12", 7, BONE)
    c.rrect(PHONE_W - 166, 60, PHONE_W - 16, 130, 16, (20, 24, 48))
    c.text(PHONE_W - 150, 74, "OPP", 3, GOLD)
    c.text(PHONE_W - 150, 98, "6", 7, BONE)
    c.rrect(PHONE_W // 2 - 46, 66, PHONE_W // 2 + 46, 124, 12, (24, 28, 54))
    c.text(PHONE_W // 2 - 16, 84, "12s", 4, GOLD)
    # die
    cx, cy = PHONE_W // 2, 380
    c.circle_shadow(cx, cy, 56, (45, 212, 192), 26)
    pr = 9
    for (ox, oy) in [(-28, -28), (28, -28), (0, 0), (-28, 28), (28, 28)]:
        c.circle(cx + ox, cy + oy, pr, (6, 34, 42))
    c.text(20, 470, "TAP THE DIE TO ROLL (7 TURNS LEFT)", 2, SLATE)
    # opponent username
    c.text(20, 540, "VS @DevB", 3, TEAL)
    write_png(os.path.join(DIR, "screenshot-game.png"), PHONE_W, PHONE_H, c.px)
    print("screenshot-game.png", PHONE_W, "x", PHONE_H)

def make_result():
    c = Canvas(PHONE_W, PHONE_H)
    c.vgrad((8, 26, 22), (10, 16, 36))
    # trophy
    cx = PHONE_W // 2
    c.circle_shadow(cx, 200, 54, GOLD, 30)
    c.text(PHONE_W // 2 - 92, 320, "VICTORY!", 8, TEAL)
    c.text(PHONE_W // 2 - 120, 400, "+0.80 WLD & +15 TNV", 4, GOLD)
    # result card
    c.rrect(30, 470, PHONE_W - 30, 600, 20, (17, 22, 44))
    c.text(50, 492, "WINNER PAYOUT", 2, SLATE)
    c.text(50, 520, "0.80 WLD", 5, TEAL)
    c.text(50, 566, "TNV REWARD", 2, SLATE)
    c.text(50, 592, "+15 TNV", 4, GOLD)
    # play again
    c.rrect(40, 630, PHONE_W - 40, 690, 16, TEAL)
    c.text(PHONE_W // 2 - 64, 648, "PLAY AGAIN", 3, (4, 18, 14))
    write_png(os.path.join(DIR, "screenshot-result.png"), PHONE_W, PHONE_H, c.px)
    print("screenshot-result.png", PHONE_W, "x", PHONE_H)

def make_bot():
    c = phone_base()
    # bot chat overlay
    c.rect(0, 0, PHONE_W, PHONE_H, (9, 12, 26))
    # header
    c.rrect(0, 0, PHONE_W, 70, 0, (24, 28, 54))
    c.text(20, 22, "PAYMENT SUPPORT BOT", 3, TEAL)
    # chat bubbles
    c.rrect(16, 96, PHONE_W - 120, 150, 14, (30, 34, 58))
    c.text(28, 108, "HI! DID YOU MAKE A PAYMENT", 2, BONE)
    c.text(28, 126, "THAT DIDN'T GET REFUNDED?", 2, BONE)
    c.rrect(PHONE_W - 170, 172, PHONE_W - 16, 216, 14, (12, 70, 60))
    c.text(PHONE_W - 158, 184, "YES, I PAID", 2, TEAL)
    c.rrect(16, 240, PHONE_W - 120, 300, 14, (30, 34, 58))
    c.text(28, 252, "SCANNING YOUR RECENT MATCHES", 2, BONE)
    c.rrect(PHONE_W - 170, 322, PHONE_W - 16, 380, 14, (12, 70, 60))
    c.text(PHONE_W - 158, 334, "0.5 WLD REFUND QUEUED!", 2, TEAL)
    # buttons
    c.rrect(16, 404, PHONE_W - 16, 452, 14, (20, 24, 48))
    c.text(28, 418, "HOW TO FIND MY TX HASH", 2, BONE)
    c.rrect(16, 462, PHONE_W - 16, 510, 14, (20, 24, 48))
    c.text(28, 476, "TALK TO AGENT AIRDROPHUBGROUP", 2, BONE)
    # input
    c.rrect(16, 560, PHONE_W - 16, 610, 14, (20, 24, 48))
    c.text(28, 574, "PASTE YOUR TRANSACTION HASH", 2, SLATE)
    c.rrect(PHONE_W - 90, 560, PHONE_W - 16, 610, 14, TEAL)
    c.text(PHONE_W - 72, 576, "SEND", 2, (4, 18, 14))
    write_png(os.path.join(DIR, "screenshot-bot.png"), PHONE_W, PHONE_H, c.px)
    print("screenshot-bot.png", PHONE_W, "x", PHONE_H)

if __name__ == "__main__":
    DIR = os.path.dirname(os.path.abspath(__file__))
    make_icon()
    make_card()
    make_home()
    make_game()
    make_result()
    make_bot()
    print("DONE — all assets written to", DIR)
