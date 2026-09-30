import { cityHintFor, latinCityName, normalizePlaceKey } from "./geo";

export type SeedPoi = {
  name: string;
  lat: number;
  lon: number;
  kind: string;
  address?: string;
  food?: boolean;
};

const SEEDS: Record<string, SeedPoi[]> = {
  paris: [
    { name: "Musée du Louvre", lat: 48.8606, lon: 2.3376, kind: "museum" },
    { name: "Jardin des Tuileries", lat: 48.8634, lon: 2.3275, kind: "park" },
    { name: "Palais-Royal", lat: 48.8635, lon: 2.3369, kind: "historic" },
    { name: "Pont Neuf", lat: 48.8566, lon: 2.3412, kind: "attraction" },
    { name: "Notre-Dame de Paris", lat: 48.853, lon: 2.3499, kind: "church" },
    { name: "Sainte-Chapelle", lat: 48.8554, lon: 2.345, kind: "church" },
    { name: "Centre Pompidou", lat: 48.8606, lon: 2.3522, kind: "museum" },
    { name: "Tour Eiffel", lat: 48.8584, lon: 2.2945, kind: "attraction" },
    { name: "Trocadéro", lat: 48.8616, lon: 2.2893, kind: "viewpoint" },
    { name: "Champ de Mars", lat: 48.8556, lon: 2.2986, kind: "park" },
    { name: "Musée d'Orsay", lat: 48.86, lon: 2.3266, kind: "museum" },
    { name: "Angelina", lat: 48.8651, lon: 2.3284, kind: "cafe", food: true },
    { name: "Le Comptoir du Relais", lat: 48.8534, lon: 2.3388, kind: "restaurant", food: true },
  ],
  rome: [
    { name: "Colosseo", lat: 41.8902, lon: 12.4922, kind: "historic" },
    { name: "Foro Romano", lat: 41.8925, lon: 12.4853, kind: "historic" },
    { name: "Fontana di Trevi", lat: 41.9009, lon: 12.4833, kind: "attraction" },
    { name: "Pantheon", lat: 41.8986, lon: 12.4769, kind: "historic" },
    { name: "Piazza Navona", lat: 41.8992, lon: 12.4731, kind: "attraction" },
    { name: "Basilica di San Pietro", lat: 41.9022, lon: 12.4539, kind: "church" },
    { name: "Castel Sant'Angelo", lat: 41.9031, lon: 12.4663, kind: "historic" },
    { name: "Musei Vaticani", lat: 41.9065, lon: 12.4536, kind: "museum" },
    { name: "Trastevere", lat: 41.8897, lon: 12.4702, kind: "attraction" },
    { name: "Roscioli", lat: 41.8945, lon: 12.4738, kind: "restaurant", food: true },
  ],
  istanbul: [
    { name: "Ayasofya", lat: 41.0086, lon: 28.9802, kind: "historic" },
    { name: "Sultanahmet Camii", lat: 41.0054, lon: 28.9768, kind: "church" },
    { name: "Topkapı Sarayı", lat: 41.0115, lon: 28.9834, kind: "historic" },
    { name: "Yerebatan Sarnıcı", lat: 41.0084, lon: 28.9779, kind: "historic" },
    { name: "Grand Bazaar", lat: 41.0106, lon: 28.968, kind: "marketplace", food: true },
    { name: "Galata Kulesi", lat: 41.0256, lon: 28.9742, kind: "viewpoint" },
    { name: "Galata Bridge", lat: 41.0201, lon: 28.9732, kind: "attraction" },
    { name: "Karaköy", lat: 41.023, lon: 28.976, kind: "attraction" },
    { name: "Hamdi Restaurant", lat: 41.0174, lon: 28.9706, kind: "restaurant", food: true },
  ],
  barcelona: [
    { name: "Sagrada Família", lat: 41.4036, lon: 2.1744, kind: "church" },
    { name: "Hospital de Sant Pau", lat: 41.4136, lon: 2.1744, kind: "historic" },
    { name: "Recinte Modernista de Sant Pau", lat: 41.412, lon: 2.175, kind: "museum" },
    { name: "Park Güell", lat: 41.4145, lon: 2.1527, kind: "park" },
    { name: "Casa Batlló", lat: 41.3917, lon: 2.165, kind: "historic" },
    { name: "Casa Milà", lat: 41.3954, lon: 2.162, kind: "historic" },
    { name: "Passeig de Gràcia", lat: 41.3919, lon: 2.1649, kind: "attraction" },
    { name: "La Rambla", lat: 41.381, lon: 2.1734, kind: "attraction" },
    { name: "Mercat de la Boqueria", lat: 41.3817, lon: 2.1719, kind: "marketplace", food: true },
    { name: "Barceloneta", lat: 41.3784, lon: 2.1925, kind: "attraction" },
  ],
  dubai: [
    { name: "Burj Khalifa", lat: 25.1972, lon: 55.2744, kind: "attraction" },
    { name: "Dubai Mall", lat: 25.1985, lon: 55.2796, kind: "attraction" },
    { name: "Dubai Fountain", lat: 25.1953, lon: 55.275, kind: "viewpoint" },
    { name: "Souk Al Bahar", lat: 25.1947, lon: 55.2766, kind: "marketplace" },
    { name: "Dubai Marina", lat: 25.0805, lon: 55.1403, kind: "attraction" },
    { name: "JBR Beach", lat: 25.078, lon: 55.133, kind: "attraction" },
    { name: "Ain Dubai", lat: 25.0808, lon: 55.1196, kind: "viewpoint" },
    { name: "Al Seef", lat: 25.264, lon: 55.297, kind: "attraction" },
    { name: "Al Fahidi Historic District", lat: 25.2637, lon: 55.2995, kind: "historic" },
  ],
  london: [
    { name: "British Museum", lat: 51.5194, lon: -0.127, kind: "museum" },
    { name: "Covent Garden", lat: 51.5117, lon: -0.123, kind: "attraction" },
    { name: "Trafalgar Square", lat: 51.508, lon: -0.1281, kind: "attraction" },
    { name: "National Gallery", lat: 51.5089, lon: -0.1283, kind: "museum" },
    { name: "Big Ben", lat: 51.5007, lon: -0.1246, kind: "historic" },
    { name: "Westminster Abbey", lat: 51.4993, lon: -0.1273, kind: "church" },
    { name: "London Eye", lat: 51.5033, lon: -0.1195, kind: "viewpoint" },
    { name: "Borough Market", lat: 51.5055, lon: -0.091, kind: "marketplace", food: true },
    { name: "Tower of London", lat: 51.5081, lon: -0.0759, kind: "historic" },
    { name: "St Paul's Cathedral", lat: 51.5138, lon: -0.0984, kind: "church" },
  ],
  tokyo: [
    { name: "Senso-ji", lat: 35.7148, lon: 139.7967, kind: "historic" },
    { name: "Nakamise-dori", lat: 35.7114, lon: 139.7948, kind: "attraction" },
    { name: "Tokyo Skytree", lat: 35.7101, lon: 139.8107, kind: "viewpoint" },
    { name: "Meiji Jingu", lat: 35.6764, lon: 139.6993, kind: "historic" },
    { name: "Takeshita Street", lat: 35.671, lon: 139.705, kind: "attraction" },
    { name: "Shibuya Crossing", lat: 35.6595, lon: 139.7004, kind: "attraction" },
    { name: "Meiji-jingumae", lat: 35.6702, lon: 139.705, kind: "attraction" },
    { name: "Tsukiji Outer Market", lat: 35.6654, lon: 139.7707, kind: "marketplace", food: true },
  ],
  bangkok: [
    { name: "Grand Palace", lat: 13.75, lon: 100.4913, kind: "historic" },
    { name: "Wat Pho", lat: 13.746, lon: 100.493, kind: "historic" },
    { name: "Wat Arun", lat: 13.7437, lon: 100.4888, kind: "historic" },
    { name: "Chao Phraya River", lat: 13.752, lon: 100.488, kind: "attraction" },
    { name: "Khao San Road", lat: 13.7589, lon: 100.4975, kind: "attraction" },
    { name: "Jim Thompson House", lat: 13.7493, lon: 100.528, kind: "museum" },
    { name: "MBK Center", lat: 13.7446, lon: 100.53, kind: "attraction" },
    { name: "Chatuchak Weekend Market", lat: 13.7999, lon: 100.5503, kind: "marketplace", food: true },
  ],
  "new york": [
    { name: "Central Park", lat: 40.7829, lon: -73.9654, kind: "park" },
    { name: "The Metropolitan Museum of Art", lat: 40.7794, lon: -73.9632, kind: "museum" },
    { name: "Fifth Avenue", lat: 40.7736, lon: -73.9654, kind: "attraction" },
    { name: "Times Square", lat: 40.758, lon: -73.9855, kind: "attraction" },
    { name: "Bryant Park", lat: 40.7536, lon: -73.9832, kind: "park" },
    { name: "Empire State Building", lat: 40.7484, lon: -73.9857, kind: "viewpoint" },
    { name: "Brooklyn Bridge", lat: 40.7061, lon: -73.9969, kind: "attraction" },
    { name: "One World Observatory", lat: 40.713, lon: -74.0132, kind: "viewpoint" },
    { name: "Chelsea Market", lat: 40.7422, lon: -74.0061, kind: "marketplace", food: true },
  ],
  bali: [
    { name: "Ubud Palace", lat: -8.5069, lon: 115.2625, kind: "historic" },
    { name: "Ubud Art Market", lat: -8.5064, lon: 115.2636, kind: "marketplace", food: true },
    { name: "Sacred Monkey Forest", lat: -8.5195, lon: 115.2606, kind: "park" },
    { name: "Tegalalang Rice Terrace", lat: -8.4312, lon: 115.2792, kind: "viewpoint" },
    { name: "Tanah Lot", lat: -8.6212, lon: 115.0868, kind: "historic" },
    { name: "Seminyak Beach", lat: -8.691, lon: 115.157, kind: "attraction" },
    { name: "Potato Head Beach Club", lat: -8.6966, lon: 115.1574, kind: "attraction" },
    { name: "Uluwatu Temple", lat: -8.8291, lon: 115.0849, kind: "historic" },
  ],
  tbilisi: [
    { name: "Narikala", lat: 41.6878, lon: 44.8089, kind: "historic" },
    { name: "Abanotubani", lat: 41.689, lon: 44.811, kind: "attraction" },
    { name: "Sioni Cathedral", lat: 41.6912, lon: 44.8076, kind: "church" },
    { name: "Bridge of Peace", lat: 41.693, lon: 44.805, kind: "attraction" },
    { name: "Rike Park", lat: 41.6936, lon: 44.8076, kind: "park" },
    { name: "Rustaveli Avenue", lat: 41.697, lon: 44.798, kind: "attraction" },
    { name: "Dry Bridge Market", lat: 41.7015, lon: 44.7955, kind: "marketplace" },
    { name: "Shavi Lomi", lat: 41.6948, lon: 44.8015, kind: "restaurant", food: true },
  ],
  yerevan: [
    { name: "Republic Square", lat: 40.1776, lon: 44.5126, kind: "attraction" },
    { name: "Cascade Complex", lat: 40.1911, lon: 44.5156, kind: "viewpoint" },
    { name: "Cafesjian Center", lat: 40.1916, lon: 44.5159, kind: "museum" },
    { name: "Northern Avenue", lat: 40.183, lon: 44.515, kind: "attraction" },
    { name: "Opera Theatre", lat: 40.1858, lon: 44.515, kind: "attraction" },
    { name: "Vernissage Market", lat: 40.1789, lon: 44.5148, kind: "marketplace" },
    { name: "GUM Market", lat: 40.1746, lon: 44.5159, kind: "marketplace", food: true },
  ],
  prague: [
    { name: "Charles Bridge", lat: 50.0865, lon: 14.4114, kind: "attraction" },
    { name: "Old Town Square", lat: 50.087, lon: 14.4208, kind: "attraction" },
    { name: "Astronomical Clock", lat: 50.087, lon: 14.4207, kind: "historic" },
    { name: "Prague Castle", lat: 50.091, lon: 14.4016, kind: "historic" },
    { name: "St. Vitus Cathedral", lat: 50.0909, lon: 14.4005, kind: "church" },
    { name: "Malá Strana", lat: 50.088, lon: 14.404, kind: "attraction" },
    { name: "Petřín Hill", lat: 50.0836, lon: 14.395, kind: "park" },
    { name: "Lokál Dlouhááá", lat: 50.0904, lon: 14.4255, kind: "restaurant", food: true },
  ],
  berlin: [
    { name: "Brandenburg Gate", lat: 52.5163, lon: 13.3777, kind: "historic" },
    { name: "Reichstag", lat: 52.5186, lon: 13.3762, kind: "historic" },
    { name: "Holocaust Memorial", lat: 52.5139, lon: 13.3787, kind: "memorial" },
    { name: "Museum Island", lat: 52.5208, lon: 13.3989, kind: "museum" },
    { name: "Berlin Cathedral", lat: 52.5192, lon: 13.4011, kind: "church" },
    { name: "Alexanderplatz", lat: 52.5219, lon: 13.4132, kind: "attraction" },
    { name: "East Side Gallery", lat: 52.505, lon: 13.4397, kind: "artwork" },
    { name: "Markthalle Neun", lat: 52.5018, lon: 13.4317, kind: "marketplace", food: true },
  ],
  amsterdam: [
    { name: "Dam Square", lat: 52.3731, lon: 4.8926, kind: "attraction" },
    { name: "Royal Palace Amsterdam", lat: 52.3732, lon: 4.8914, kind: "historic" },
    { name: "Anne Frank House", lat: 52.3752, lon: 4.884, kind: "museum" },
    { name: "Westerkerk", lat: 52.3746, lon: 4.8837, kind: "church" },
    { name: "Rijksmuseum", lat: 52.36, lon: 4.8852, kind: "museum" },
    { name: "Van Gogh Museum", lat: 52.3584, lon: 4.8811, kind: "museum" },
    { name: "Vondelpark", lat: 52.3579, lon: 4.8686, kind: "park" },
    { name: "Albert Cuyp Market", lat: 52.356, lon: 4.8954, kind: "marketplace", food: true },
  ],
  lisbon: [
    { name: "Praça do Comércio", lat: 38.7075, lon: -9.1364, kind: "attraction" },
    { name: "Arco da Rua Augusta", lat: 38.7086, lon: -9.1367, kind: "historic" },
    { name: "Sé de Lisboa", lat: 38.7098, lon: -9.1328, kind: "church" },
    { name: "Castelo de São Jorge", lat: 38.7139, lon: -9.1335, kind: "historic" },
    { name: "Miradouro da Senhora do Monte", lat: 38.719, lon: -9.1326, kind: "viewpoint" },
    { name: "Tram 28", lat: 38.713, lon: -9.133, kind: "attraction" },
    { name: "Belém Tower", lat: 38.6916, lon: -9.216, kind: "historic" },
    { name: "Jerónimos Monastery", lat: 38.6979, lon: -9.2067, kind: "church" },
    { name: "Time Out Market", lat: 38.707, lon: -9.1457, kind: "marketplace", food: true },
  ],
  moscow: [
    { name: "Красная площадь", lat: 55.7539, lon: 37.6208, kind: "attraction" },
    { name: "Храм Василия Блаженного", lat: 55.7525, lon: 37.6231, kind: "church" },
    { name: "ГУМ", lat: 55.7546, lon: 37.6215, kind: "attraction" },
    { name: "Мавзолей Ленина", lat: 55.7537, lon: 37.6199, kind: "historic" },
    { name: "Александровский сад", lat: 55.7525, lon: 37.6136, kind: "park" },
    { name: "Большой театр", lat: 55.7601, lon: 37.6186, kind: "attraction" },
    { name: "Парк Зарядье", lat: 55.7513, lon: 37.6286, kind: "park" },
    { name: "Столовка №57", lat: 55.7547, lon: 37.6218, kind: "cafe", food: true },
  ],
  "saint petersburg": [
    { name: "Эрмитаж", lat: 59.9398, lon: 30.3146, kind: "museum" },
    { name: "Дворцовая площадь", lat: 59.9387, lon: 30.3146, kind: "attraction" },
    { name: "Исаакиевский собор", lat: 59.934, lon: 30.3061, kind: "church" },
    { name: "Медный всадник", lat: 59.9364, lon: 30.3022, kind: "monument" },
    { name: "Спас на Крови", lat: 59.9401, lon: 30.3289, kind: "church" },
    { name: "Невский проспект", lat: 59.935, lon: 30.325, kind: "attraction" },
    { name: "Казанский собор", lat: 59.9342, lon: 30.3245, kind: "church" },
    { name: "Петропавловская крепость", lat: 59.95, lon: 30.3167, kind: "historic" },
    { name: "Териберка (бар)", lat: 59.9348, lon: 30.323, kind: "restaurant", food: true },
  ],
  kazan: [
    { name: "Казанский кремль", lat: 55.7989, lon: 49.1064, kind: "historic" },
    { name: "Кул-Шариф", lat: 55.7985, lon: 49.1051, kind: "church" },
    { name: "Башня Сююмбике", lat: 55.8003, lon: 49.1059, kind: "historic" },
    { name: "Улица Баумана", lat: 55.791, lon: 49.113, kind: "attraction" },
    { name: "Дворец земледельцев", lat: 55.7966, lon: 49.1088, kind: "attraction" },
    { name: "Чак-чак музей", lat: 55.7889, lon: 49.1225, kind: "museum" },
    { name: "Дом татарской кулинарии", lat: 55.7904, lon: 49.1142, kind: "restaurant", food: true },
  ],
  sochi: [
    { name: "Морской вокзал", lat: 43.5806, lon: 39.7186, kind: "attraction" },
    { name: "Ривьера парк", lat: 43.592, lon: 39.716, kind: "park" },
    { name: "Дендрарий", lat: 43.565, lon: 39.739, kind: "park" },
    { name: "Набережная Сочи", lat: 43.577, lon: 39.725, kind: "attraction" },
    { name: "Зимний театр", lat: 43.5756, lon: 39.7285, kind: "attraction" },
    { name: "Кафе Приморское", lat: 43.5778, lon: 39.7254, kind: "cafe", food: true },
  ],
  suzdal: [
    { name: "Суздальский кремль", lat: 56.4217, lon: 40.4428, kind: "historic" },
    { name: "Рождественский собор", lat: 56.4212, lon: 40.4422, kind: "church" },
    { name: "Торговые ряды", lat: 56.4228, lon: 40.4484, kind: "marketplace", food: true },
    { name: "Спасо-Евфимиев монастырь", lat: 56.433, lon: 40.441, kind: "church" },
    { name: "Покровский монастырь", lat: 56.4295, lon: 40.437, kind: "church" },
    { name: "Музей деревянного зодчества", lat: 56.4168, lon: 40.4415, kind: "museum" },
  ],
  derbent: [
    { name: "Нарын-Кала", lat: 42.0533, lon: 48.2742, kind: "historic" },
    { name: "Джума-мечеть", lat: 42.055, lon: 48.277, kind: "church" },
    { name: "Крепостные стены", lat: 42.0544, lon: 48.2755, kind: "historic" },
    { name: "Магалы Старого города", lat: 42.056, lon: 48.288, kind: "attraction" },
    { name: "Набережная Дербента", lat: 42.057, lon: 48.3, kind: "attraction" },
    { name: "Чайхана у крепости", lat: 42.0548, lon: 48.276, kind: "cafe", food: true },
  ],
  "gorno-altaysk": [
    { name: "Национальный музей Алтая", lat: 51.9584, lon: 85.9601, kind: "museum" },
    { name: "Парк Победы", lat: 51.961, lon: 85.967, kind: "park" },
    { name: "Набережная Маймы", lat: 51.954, lon: 85.955, kind: "attraction" },
    { name: "Гора Тугая", lat: 51.95, lon: 85.94, kind: "viewpoint" },
    { name: "Центральный рынок", lat: 51.957, lon: 85.963, kind: "marketplace", food: true },
    { name: "Кафе Катунь", lat: 51.9588, lon: 85.961, kind: "cafe", food: true },
  ],
  "petropavlovsk-kamchatsky": [
    { name: "Никольская сопка", lat: 53.016, lon: 158.646, kind: "viewpoint" },
    { name: "Набережная Култучного озера", lat: 53.02, lon: 158.645, kind: "attraction" },
    { name: "Мишенная сопка", lat: 53.05, lon: 158.66, kind: "viewpoint" },
    { name: "Краеведческий музей", lat: 53.024, lon: 158.649, kind: "museum" },
    { name: "Рыбный рынок", lat: 53.022, lon: 158.648, kind: "marketplace", food: true },
    { name: "Кафе Вулкан", lat: 53.021, lon: 158.647, kind: "cafe", food: true },
  ],
  irkutsk: [
    { name: "130-й квартал", lat: 52.286, lon: 104.281, kind: "attraction" },
    { name: "Набережная Ангары", lat: 52.289, lon: 104.28, kind: "attraction" },
    { name: "Спасская церковь", lat: 52.2895, lon: 104.278, kind: "church" },
    { name: "Краеведческий музей", lat: 52.288, lon: 104.28, kind: "museum" },
    { name: "Сквер Кирова", lat: 52.2865, lon: 104.2805, kind: "park" },
    { name: "Позднякoff", lat: 52.287, lon: 104.282, kind: "restaurant", food: true },
  ],
  petrozavodsk: [
    { name: "Онежская набережная", lat: 61.789, lon: 34.39, kind: "attraction" },
    { name: "Площадь Кирова", lat: 61.7895, lon: 34.364, kind: "attraction" },
    { name: "Национальный музей Карелии", lat: 61.787, lon: 34.351, kind: "museum" },
    { name: "Парк Победы", lat: 61.792, lon: 34.37, kind: "park" },
    { name: "Кафе Карелия", lat: 61.788, lon: 34.36, kind: "cafe", food: true },
  ],
  kaliningrad: [
    { name: "Кафедральный собор", lat: 54.7064, lon: 20.5119, kind: "church" },
    { name: "Остров Канта", lat: 54.706, lon: 20.5125, kind: "attraction" },
    { name: "Рыбная деревня", lat: 54.7045, lon: 20.5138, kind: "attraction" },
    { name: "Амалиенау", lat: 54.721, lon: 20.48, kind: "historic" },
    { name: "Верхнее озеро", lat: 54.7215, lon: 20.51, kind: "park" },
    { name: "Марципановая лавка", lat: 54.7068, lon: 20.512, kind: "cafe", food: true },
  ],
};

const SEED_ALIASES: Record<string, string> = {
  baikal: "irkutsk",
  altai: "gorno-altaysk",
  dagestan: "derbent",
  karelia: "petrozavodsk",
  kamchatka: "petropavlovsk-kamchatsky",
};

function keyVariants(city: string): string[] {
  const latin = latinCityName(city).toLowerCase();
  const raw = normalizePlaceKey(city);
  const hint = cityHintFor(city);
  const keys = [...new Set([latin, raw, hint?.name?.toLowerCase() || ""].filter(Boolean))];
  const extra = keys.map((k) => SEED_ALIASES[k]).filter(Boolean);
  return [...new Set([...keys, ...extra])];
}

export function seedLandmarks(city: string): SeedPoi[] {
  const keys = keyVariants(city);
  let list: SeedPoi[] = [];
  for (const k of keys) {
    if (SEEDS[k]) {
      list = SEEDS[k];
      break;
    }
  }
  const hint = cityHintFor(city);
  return list.map((p) => ({
    ...p,
    address: p.address || hint?.address || city,
    food: Boolean(p.food),
  }));
}
