const COURSES = [
  {
    id: 'seagolf-meri',
    name: 'SeaGolf Meri',
    club: 'Sea Golf Rönnäs',
    domain: 'api.seagolf.fi',
    productId: 7,
    golfId: 1,
    closedIfNoRows: true,  // pre-creates slots (status 4 visible)
  },
  {
    id: 'seagolf-puisto',
    name: 'SeaGolf Puisto',
    club: 'Sea Golf Rönnäs',
    domain: 'api.seagolf.fi',
    productId: 8,
    golfId: 1,
    closedIfNoRows: false, // only creates rows on booking
  },
  {
    id: 'shg-luukki',
    name: 'SHG Luukki',
    club: 'Suur-Helsingin Golf',
    domain: 'api.shg.fi',
    productId: 53,
    golfId: 1,
    resourceId: 1,
    closedIfNoRows: false,
    memberOnlyMinutes: [20, 50],
  },
  {
    id: 'shg-lakisto',
    name: 'SHG Lakisto',
    club: 'Suur-Helsingin Golf',
    domain: 'api.shg.fi',
    productId: 53,
    golfId: 1,
    resourceId: 2,
    closedIfNoRows: false,
    memberOnlyMinutes: [20, 50],
  },
  {
    id: 'ringside',
    name: 'Ringside Golf',
    club: 'Espoo Ringside Golf',
    domain: 'api.ringsidegolf.fi',
    productId: 17,
    golfId: 1,
    closedIfNoRows: true,  // pre-creates slots (status 4 visible)
  },
  {
    id: 'gumbole',
    name: 'Gumböle Golf',
    club: 'Gumböle Golf',
    domain: 'api.espoogolf.fi',
    productId: 29,
    golfId: 1,
    closedIfNoRows: true,  // pre-creates slots (status 4 visible)
  },
  {
    id: 'tgk',
    name: 'Tuusulan GK',
    club: 'Tuusulan Golfklubi',
    domain: 'api.tgk.fi',
    productId: 108,
    golfId: 1,
    closedIfNoRows: true,  // pre-creates slots (status 4 visible)
  },
  {
    id: 'hirvihaara',
    name: 'Hirvihaara Golf',
    club: 'Hirvihaara Golf Mäntsälä',
    domain: 'api.hirvihaarangolf.fi',
    productId: 7,
    golfId: 1,
    closedIfNoRows: false,
    memberOnlyRules: [
      // Weekends: whole-hour slots 08:00–16:00 are member-only
      { minutes: [0], hours: { from: 8, to: 16 }, weekendOnly: true },
    ],
  },
  {
    id: 'hyvigolf',
    name: 'Hyvigolf',
    club: 'Hyvinkään Golf',
    domain: 'api.hyvigolf.fi',
    productId: 413,
    golfId: 1,
    closedIfNoRows: true,  // pre-creates slots (status 4 visible)
  },
  {
    id: 'keimola-kirkka',
    name: 'Keimola Kirkka',
    club: 'Keimola Golf',
    domain: 'api.keimolagolf.com',
    productId: 165,
    golfId: 1,
    closedIfNoRows: false,
  },
  {
    id: 'keimola-saras',
    name: 'Keimola Saras',
    club: 'Keimola Golf',
    domain: 'api.keimolagolf.com',
    productId: 166,
    golfId: 1,
    closedIfNoRows: false,
  },
];

module.exports = COURSES;
