# -*- coding: utf-8 -*-
"""Тестовые данные — под реальный ассортимент Flowers Batum Flower, чтобы
сразу было на чём проверить каталог, склад и заказы."""
from models import get_db, init_db

PLACEHOLDER_PHOTO = "/static/img/placeholder.svg"


def seed():
    init_db(reset=True)
    conn = get_db()
    cur = conn.cursor()

    cur.executemany(
        "INSERT INTO locations (id, name, address) VALUES (?, ?, ?)",
        [
            (1, "Parnavaza St", "ул. Парнаваза, Батуми"),
            (2, "Batumi View", "Новый бульвар, ЖК Batumi View, Батуми"),
        ],
    )

    categories = [
        (1, "bouquets", "Букеты на каждый день", 1),
        (2, "weddings", "Свадьбы и мероприятия", 2),
        (3, "balloons", "Шары", 3),
        (4, "wrapping", "Подарочная упаковка", 4),
    ]
    cur.executemany(
        "INSERT INTO categories (id, slug, name, sort_order) VALUES (?, ?, ?, ?)",
        categories,
    )

    # --- Склад: сырьё ---
    stock = [
        (1, 1, "Роза Netherlands красная 60см", "шт", 240, 50, "Нидерланды"),
        (2, 1, "Роза Ecuador розовая 70см", "шт", 90, 40, "Эквадор"),
        (3, 1, "Тюльпан микс", "шт", 150, 30, "Местный питомник"),
        (4, 1, "Эвкалипт", "ветка", 60, 15, "Местный питомник"),
        (5, 1, "Гипсофила", "ветка", 40, 15, "Кения"),
        (6, 2, "Роза Netherlands красная 60см", "шт", 30, 50, "Нидерланды"),
    ]
    cur.executemany(
        "INSERT INTO flower_stock (id, location_id, name, unit, quantity, low_stock_threshold, supplier) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        stock,
    )

    # --- Товары ---
    products = [
        (1, 1, 1, "Букет «Батуми»", "Розы Netherlands, эвкалипт, авторская сборка",
         "11 роз, эвкалипт", PLACEHOLDER_PHOTO, "in_stock", "романтика,день рождения"),
        (2, 1, 1, "Букет «Бульвар»", "Тюльпаны микс с гипсофилой",
         "15 тюльпанов, гипсофила", PLACEHOLDER_PHOTO, "in_stock", "весна,просто так"),
        (3, 1, 2, "Свадебный букет невесты", "Под цвет и стиль мероприятия, обсуждается индивидуально",
         "розы, эвкалипт, лента", PLACEHOLDER_PHOTO, "made_to_order", "свадьба"),
        (4, 1, 3, "Шар фольгированный «Сердце»", "Гелиевый шар, 45 см",
         "1 шар", PLACEHOLDER_PHOTO, "in_stock", "день рождения,романтика"),
    ]
    cur.executemany(
        "INSERT INTO products (id, location_id, category_id, name, description, composition, "
        "photo_url, status, occasion_tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        products,
    )

    variants = [
        (1, 1, "S — 11 роз", 95),
        (2, 1, "M — 25 роз", 190),
        (3, 2, "Стандарт — 15 тюльпанов", 65),
        (4, 3, "По согласованию", 0),
        (5, 4, "1 шт", 25),
    ]
    cur.executemany(
        "INSERT INTO product_variants (id, product_id, label, price) VALUES (?, ?, ?, ?)",
        variants,
    )

    # --- Рецепт букета «Батуми» (для автосписания при продаже) ---
    cur.executemany(
        "INSERT INTO product_recipe (product_id, flower_stock_id, quantity_needed) VALUES (?, ?, ?)",
        [(1, 1, 11), (1, 4, 2)],
    )

    # --- Персонал ---
    cur.executemany(
        "INSERT INTO staff (telegram_id, name, role) VALUES (?, ?, ?)",
        [
            ("111111111", "Владелец", "owner"),
            ("222222222", "Флорист Тамара", "florist"),
            ("333333333", "Курьер Гиви", "courier"),
        ],
    )

    conn.commit()
    conn.close()
    print("Тестовые данные загружены: 2 точки, 4 категории, 4 товара, склад, 3 сотрудника")


if __name__ == "__main__":
    seed()
