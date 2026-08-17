/**
 * Track8 - Tanglish reminder lines (data only)
 *
 * Just the words. The picking, the name substitution and the switch that turns
 * any of this on live in js/quips.js; this file exists so lines can be added by
 * the hundred without touching logic, and so a future batch from a model can be
 * dropped in the same shape.
 *
 * House rules for anything added here:
 *   - Under 90 characters. Longer and Android truncates it in the shade.
 *   - {n} is minutes past the allowance. {name} is the person's first name, and
 *     is dropped cleanly when there is not one - so write lines that still read
 *     without it, and always as "{name}, ..." with the comma.
 *   - Teasing, never insulting. Someone reads this at 3pm on a bad day.
 *   - No emoji: the notification already carries one in its title.
 */
(function (global) {
  'use strict';

  global.T8QuipsTanglish = {
    BREAK: [
      'Coffee break-nu sonninga, {n} min extra aachu. Chair unakku waiting.',
      '{name}, break-la PhD panreengala? Vela wait pannuthu.',
      'Tea kadai-ya illa kalyanam-a? {n} min over ithu varai.',
      'Meter ODI kitte iruku, aana hours count aagala.',
      'Sema break. Ippo konjam sema ya velayum pannalam.',
      '{name}, 8 hours thaana target? Break thaan 8 hrs aakidum polaruku.',
      'Stretch panniachu, scroll panniachu, {n} mins um poyachu. Back to work!',
      'Break timer red-la iruku. Un boss-um red-la anga irupaaru.',
      'Oru cutting tea {n} min aaguma? Neenga tea estate vechuruppeenga.',
      '{name}, laptop lock aayiduchu, neenga innum unlock aagala.',
      'Break {n} min over. Timesheet paathu timesheet-ae azhuthu.',
      'Enna, canteen-la resign letter kudutheengala? Vaanga vela.',
      '{name}, break-ku break venuma? Vandhu login pannunga.',
      'Coffee aaridichu, keyboard aaridichu, neenga mattum aaraliye.',
      'Idhu break-a illa mini vacation-a? {n} min over.',
      'Konjam nadandhaachu, pesiyaachu. Ippo type panna vaanga.',
      '{name}, ungala thedi mouse cursor kaathu iruku.',
      'Break {n} min. Clock-ku ippo unmela full doubt.',
      'Smoke break-a, snack break-a, enna break? Hours-a mattum kuraiyaadha.',
      'Vaanga boss, deadline ungala miss pannuthu.',
      '{name}, ini break edutha, lunch cancel aagidum. Just saying.',
      'Chair-la thool padinjidum. {n} min over da.',
      'Ungaloda 8 hours target ippo 8 hours 30-a maara poguthu.',
      'Break over-nu clock sollichu. Naan messenger mattum thaan.'
    ],

    LUNCH: [
      'Saapadu over-a? Plate kaali, clock-in time innum wait panudhu.',
      'Lunch {n} min over. Meals-a illa marriage sappadu-a?',
      '{name}, food coma-la irundhu slowly wake up pannunga.',
      'Curd rice sema thaan, aana 8 hours-um venum boss.',
      'Lunch break-a illa lunch shift-a? {n} min extra.',
      '{name}, saapatuku appuram thookam illa, vela. Vaanga.',
      'Sappadu mudinja, laptop-um pasi-la iruku. {n} min over.',
      'Nalla saaptaachu. Ippo timesheet-a nalla pannalaam.',
      'Biryani-ku appuram brain restart aaga {n} min aachu. Podhum.',
      '{name}, plate kaali, inbox full. Balance pannunga.',
      'Lunch {n} min over. Hotel-la ungalukku table permanent-a kudukalaam.',
      'Saaptaachu, paesiyaachu, siriththaachu. Ippo velai.',
      '{name}, meals-ku appuram meeting iruku. Nyaabagam iruka?',
      'Parotta kanaku-la {n} min. Vela kanaku-la zero.',
      'Lunch nera vela-ah maathunga boss, clock kaathu iruku.',
      'Sappadu sema, aana salary sappadu-ku illa. Vaanga.',
      '{name}, thooki mudichitteengala? Login pannalaam.',
      'Lunch {n} min over. Evening snacks-um ippove sethu saapdreengala?',
      'Rice coma is real. Aana deadline-um real thaan.',
      'Kai kazhuvi aachu-nu nenaikiren. Keyboard kaathirukku.',
      '{name}, saapadu 8 course-a? Namma target 8 hours mattum thaan.',
      'Lunch break {n} min over. Chair-kku ippo separation feeling.',
      'Meals mudinjadhu, meeting mudiyala. Vaanga.',
      'Innum konjam neram-nu sonna, dinner-um ingaye aagidum.'
    ],

    PAUSE: [
      'Pause-la {n} min. Onnume count aagala.',
      '{name}, pause-ku pause vechuteengala?',
      'Clock nikkuthu, salary-um nikkum.',
      'Freeze aagi {n} min aachu. Melt pannunga.',
      '{name}, day hold-la iruku. Namma resume pannalama?',
      'Pause podhum boss. Play pannunga.',
      'Ithu pause-a illa power nap-a?',
      'Timer sleep mode-la. Neenga?'
    ],

    MEETING: [
      'Meeting {n} min. Yaaru pesuranga theriyala.',
      '{name}, idhu oru email-la mudinjirukum.',
      '"Circle back" sonna odanae odiduvom.',
      'Meeting marathon: {n} min complete.',
      '{name}, mute pannitu escape pannunga.',
      'Nalla vishayam - meeting count aagum.',
      'Innum pesikitte iruka? {n} min aachu.',
      'Agenda item onnu: veliya poradhu.'
    ],

    STRETCH: [
      '{n} min non-stop. Konjam elunthu nadanga.',
      '{name}, muthugu complaint kudukudhu.',
      'Break illama {n} min. Kaal irukka nyaabagam?',
      'Tea sapdunga boss, brain restart aagum.',
      '{name}, konjam thanni kudinga. Seriously.',
      'Screen-a paathadhu podhum. Sun-a paarunga.',
      'Ippo break edutha, evening-la thookam varaadhu.',
      'Non-stop hero. Aana muthugu villain aagum.'
    ],

    OVERTIME: [
      '8 hours mudinjadhu. Kilambalaam!',
      '{name}, target hit. Ippo ellam bonus.',
      'Goal thaandi {n} min. Podhum boss.',
      'Naalaikkum oru naal iruku. End day pannunga.',
      '{name}, veetla saapadu kaathiruku.',
      'Overtime {n} min. Company gift-a?',
      'Target over. Laptop-a close pannunga.',
      'Innum irundha naalaiku thookam thaan mitham.'
    ]
  };
})(typeof window !== 'undefined' ? window : globalThis);
