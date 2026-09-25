// 29 habitat classes from habitatTypes.xlsx (Bolshoy Khingan), grouped by land-cover type.
// Fields: code = zero-padded class_id, id = class_id, group_ru/group_zh = land-cover group, ru/zh = names shown in UI, en = class_en (files only).
window.HABITAT_CLASSES = [
 {
  "code": "01",
  "id": 1,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Larch-dominated larch–birch forest",
  "ru": "Лиственничные с берёзой",
  "zh": "落叶松占优的落叶松白桦林"
 },
 {
  "code": "02",
  "id": 2,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Codominant birch–larch forest",
  "ru": "Берёзово-лиственничные с примерно равными долями",
  "zh": "白桦与落叶松共优林"
 },
 {
  "code": "03",
  "id": 3,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Birch-dominated birch–larch forest",
  "ru": "Берёзовые с лиственницей",
  "zh": "白桦占优的白桦落叶松林"
 },
 {
  "code": "04",
  "id": 4,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Pine forest",
  "ru": "Сосновые леса",
  "zh": "樟子松林"
 },
 {
  "code": "05",
  "id": 5,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Oak and oak–small-leaved forest",
  "ru": "Дубово-мелколиственные леса",
  "zh": "蒙古栎及阔叶混交林"
 },
 {
  "code": "06",
  "id": 6,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Floodplain and riparian small-leaved forest",
  "ru": "Пойменные и околоводные мелколиственные леса",
  "zh": "河漫滩与近水阔叶林"
 },
 {
  "code": "07",
  "id": 7,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Paludified birch–willow forest",
  "ru": "Заболоченные берёзово-ивовые леса",
  "zh": "沼泽化白桦柳林"
 },
 {
  "code": "08",
  "id": 8,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Sparse larch woodland",
  "ru": "Лиственничные редколесья",
  "zh": "落叶松疏林"
 },
 {
  "code": "09",
  "id": 9,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Forest plantation",
  "ru": "Лесокультуры",
  "zh": "人工林"
 },
 {
  "code": "10",
  "id": 10,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Young stands on clear-cuts",
  "ru": "Молодняки на вырубках",
  "zh": "采伐迹地幼林"
 },
 {
  "code": "11",
  "id": 11,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Post-fire communities",
  "ru": "Постпирогенные сообщества",
  "zh": "火烧迹地群落"
 },
 {
  "code": "12",
  "id": 12,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Mixed birch–spruce–fir forests",
  "ru": "Берёзово-темнохвойные смешанные леса",
  "zh": "桦木与云冷杉混交林"
 },
 {
  "code": "13",
  "id": 13,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Birch forests without larch",
  "ru": "Берёзовые леса без лиственницы",
  "zh": "无落叶松混生的桦木林"
 },
 {
  "code": "14",
  "id": 14,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Stone-birch forests and krummholz",
  "ru": "Каменноберёзовые леса и криволесья",
  "zh": "岳桦林及岳桦矮曲林"
 },
 {
  "code": "15",
  "id": 15,
  "group_ru": "Лес",
  "group_zh": "森林",
  "en": "Waterlogged open woodlands",
  "ru": "Заболоченные редколесья",
  "zh": "沼泽化疏林"
 },
 {
  "code": "16",
  "id": 16,
  "group_ru": "Кустарники",
  "group_zh": "灌丛",
  "en": "Xeric shrub thicket (shibliak)",
  "ru": "Шибляк",
  "zh": "旱生灌丛"
 },
 {
  "code": "17",
  "id": 17,
  "group_ru": "Кустарники",
  "group_zh": "灌丛",
  "en": "Siberian dwarf pine scrub",
  "ru": "Заросли кедрового стланика",
  "zh": "偃松灌丛"
 },
 {
  "code": "18",
  "id": 18,
  "group_ru": "Болота",
  "group_zh": "沼泽",
  "en": "Transitional mire",
  "ru": "Переходные болота",
  "zh": "中营养沼泽（过渡沼泽）"
 },
 {
  "code": "19",
  "id": 19,
  "group_ru": "Болота",
  "group_zh": "沼泽",
  "en": "Minerotrophic fen",
  "ru": "Низинные болота",
  "zh": "低位沼泽（富营养）"
 },
 {
  "code": "20",
  "id": 20,
  "group_ru": "Болота",
  "group_zh": "沼泽",
  "en": "Raised bog",
  "ru": "Верховые болота",
  "zh": "高位沼泽（贫营养）"
 },
 {
  "code": "21",
  "id": 21,
  "group_ru": "Болота",
  "group_zh": "沼泽",
  "en": "Subalpine herbaceous wetlands",
  "ru": "Субальпийские травяные болота",
  "zh": "亚高山草本沼泽"
 },
 {
  "code": "22",
  "id": 22,
  "group_ru": "Луга",
  "group_zh": "草甸",
  "en": "Floodplain meadow",
  "ru": "Пойменные луга",
  "zh": "河漫滩草甸"
 },
 {
  "code": "23",
  "id": 23,
  "group_ru": "Луга",
  "group_zh": "草甸",
  "en": "Shrub-encroached meadow",
  "ru": "Закустаренные луга",
  "zh": "灌丛化草甸"
 },
 {
  "code": "24",
  "id": 24,
  "group_ru": "Луга",
  "group_zh": "草甸",
  "en": "Grazed pasture",
  "ru": "Пастбищные луга",
  "zh": "放牧草地"
 },
 {
  "code": "25",
  "id": 25,
  "group_ru": "Луга",
  "group_zh": "草甸",
  "en": "Ruderal vegetation",
  "ru": "Рудеральные луга",
  "zh": "杂草（人为干扰）植被"
 },
 {
  "code": "26",
  "id": 26,
  "group_ru": "Околоводные",
  "group_zh": "近水",
  "en": "River channels and bars",
  "ru": "Русла и урезы",
  "zh": "河道与河滩"
 },
 {
  "code": "27",
  "id": 27,
  "group_ru": "Антропогенные",
  "group_zh": "人为",
  "en": "Cropland",
  "ru": "Агрокультуры",
  "zh": "农田"
 },
 {
  "code": "28",
  "id": 28,
  "group_ru": "Антропогенные",
  "group_zh": "人为",
  "en": "Built-up and industrial land",
  "ru": "Застройка и промзоны",
  "zh": "建设用地与工业用地"
 },
 {
  "code": "29",
  "id": 29,
  "group_ru": "Прочее",
  "group_zh": "其他",
  "en": "No habitat description",
  "ru": "Нет описания",
  "zh": "无生境描述"
 }
];
