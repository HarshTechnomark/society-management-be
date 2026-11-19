import type { NoticeCategory, NoticeKind, UtilityType } from './communication.constants';

/** 8.3 notice template library: code constant, 8 templates x `en-IN`, `hi-IN`, `mr-IN`. Nothing is stored. Placeholders in [brackets] are filled by the author. */
export interface NoticeTemplate {
  key: string;
  locale: 'en-IN' | 'hi-IN' | 'mr-IN';
  title: string;
  body: string;
  category: NoticeCategory;
  kind: NoticeKind;
  utilityType: UtilityType | null;
}

interface Base {
  key: string;
  category: NoticeCategory;
  kind: NoticeKind;
  utilityType: UtilityType | null;
  text: Record<NoticeTemplate['locale'], { title: string; body: string }>;
}

const BASES: Base[] = [
  {
    key: 'water_cut',
    category: 'MAINTENANCE',
    kind: 'UTILITY_SHUTDOWN',
    utilityType: 'WATER',
    text: {
      'en-IN': {
        title: 'Water supply cut on [date], [start time] to [end time]',
        body: '<p>Dear residents, water supply will be off on <strong>[date]</strong> from <strong>[start time] to [end time]</strong> for tank cleaning.</p><p>Please store enough water in advance. Supply will resume once the work is complete.</p>',
      },
      'hi-IN': {
        title: 'पानी की आपूर्ति बंद: [तारीख], [शुरू समय] से [अंतिम समय] तक',
        body: '<p>प्रिय निवासियो, टंकी की सफाई के कारण <strong>[तारीख]</strong> को <strong>[शुरू समय] से [अंतिम समय]</strong> तक पानी की आपूर्ति बंद रहेगी।</p><p>कृपया पहले से पर्याप्त पानी जमा कर लें। काम पूरा होने पर आपूर्ति फिर शुरू होगी।</p>',
      },
      'mr-IN': {
        title: 'पाणीपुरवठा बंद: [तारीख], [सुरू वेळ] ते [शेवटची वेळ]',
        body: '<p>प्रिय रहिवाशांनो, टाकी साफसफाईमुळे <strong>[तारीख]</strong> रोजी <strong>[सुरू वेळ] ते [शेवटची वेळ]</strong> पाणीपुरवठा बंद राहील.</p><p>कृपया आधीच पुरेसे पाणी साठवून ठेवा. काम पूर्ण झाल्यावर पुरवठा पुन्हा सुरू होईल.</p>',
      },
    },
  },
  {
    key: 'power_shutdown',
    category: 'MAINTENANCE',
    kind: 'UTILITY_SHUTDOWN',
    utilityType: 'POWER',
    text: {
      'en-IN': {
        title: 'Planned power shutdown on [date], [start time] to [end time]',
        body: '<p>Electricity will be switched off on <strong>[date]</strong> from <strong>[start time] to [end time]</strong> for electrical maintenance.</p><p>Lifts and common lighting may be affected. Please plan accordingly.</p>',
      },
      'hi-IN': {
        title: 'बिजली बंद रहेगी: [तारीख], [शुरू समय] से [अंतिम समय] तक',
        body: '<p>विद्युत रखरखाव के कारण <strong>[तारीख]</strong> को <strong>[शुरू समय] से [अंतिम समय]</strong> तक बिजली बंद रहेगी।</p><p>लिफ्ट और सामान्य रोशनी प्रभावित हो सकती हैं। कृपया उसी अनुसार योजना बनाएं।</p>',
      },
      'mr-IN': {
        title: 'वीज बंद राहील: [तारीख], [सुरू वेळ] ते [शेवटची वेळ]',
        body: '<p>विद्युत देखभालीमुळे <strong>[तारीख]</strong> रोजी <strong>[सुरू वेळ] ते [शेवटची वेळ]</strong> वीज बंद राहील.</p><p>लिफ्ट आणि सामायिक दिवे प्रभावित होऊ शकतात. कृपया त्यानुसार नियोजन करा.</p>',
      },
    },
  },
  {
    key: 'lift_maintenance',
    category: 'MAINTENANCE',
    kind: 'UTILITY_SHUTDOWN',
    utilityType: 'LIFT',
    text: {
      'en-IN': {
        title: 'Lift maintenance in [building] on [date]',
        body: '<p>The lifts in <strong>[building]</strong> will be under maintenance on <strong>[date]</strong> from <strong>[start time] to [end time]</strong>.</p><p>Please use the stairs during this time. Senior citizens may call the office for help.</p>',
      },
      'hi-IN': {
        title: '[भवन] में लिफ्ट का रखरखाव: [तारीख]',
        body: '<p><strong>[भवन]</strong> की लिफ्ट <strong>[तारीख]</strong> को <strong>[शुरू समय] से [अंतिम समय]</strong> तक रखरखाव में रहेंगी।</p><p>कृपया इस दौरान सीढ़ियों का उपयोग करें। वरिष्ठ नागरिक सहायता के लिए कार्यालय को फोन करें।</p>',
      },
      'mr-IN': {
        title: '[इमारत] मधील लिफ्ट देखभाल: [तारीख]',
        body: '<p><strong>[इमारत]</strong> मधील लिफ्ट <strong>[तारीख]</strong> रोजी <strong>[सुरू वेळ] ते [शेवटची वेळ]</strong> देखभालीत असतील.</p><p>कृपया या काळात जिन्याचा वापर करा. ज्येष्ठ नागरिकांनी मदतीसाठी कार्यालयाशी संपर्क साधावा.</p>',
      },
    },
  },
  {
    key: 'agm_notice',
    category: 'GOVERNANCE',
    kind: 'STANDARD',
    utilityType: null,
    text: {
      'en-IN': {
        title: 'Notice of Annual General Meeting on [date]',
        body: "<p>The Annual General Meeting of the society will be held on <strong>[date]</strong> at <strong>[time]</strong> at <strong>[venue]</strong>.</p><h4>Agenda</h4><ol><li>Confirmation of the previous minutes</li><li>Audited accounts and budget</li><li>Election of the managing committee</li><li>Any other matter with the chair's permission</li></ol><p>Your presence is requested.</p>",
      },
      'hi-IN': {
        title: 'वार्षिक आम बैठक की सूचना: [तारीख]',
        body: '<p>सोसायटी की वार्षिक आम बैठक <strong>[तारीख]</strong> को <strong>[समय]</strong> बजे <strong>[स्थान]</strong> पर होगी।</p><h4>कार्यसूची</h4><ol><li>पिछली बैठक के कार्यवृत्त की पुष्टि</li><li>लेखा परीक्षित खाते और बजट</li><li>प्रबंध समिति का चुनाव</li><li>अध्यक्ष की अनुमति से अन्य विषय</li></ol><p>आपकी उपस्थिति अपेक्षित है।</p>',
      },
      'mr-IN': {
        title: 'वार्षिक सर्वसाधारण सभेची सूचना: [तारीख]',
        body: '<p>सोसायटीची वार्षिक सर्वसाधारण सभा <strong>[तारीख]</strong> रोजी <strong>[वेळ]</strong> वाजता <strong>[ठिकाण]</strong> येथे होईल.</p><h4>कार्यसूची</h4><ol><li>मागील इतिवृत्ताची पुष्टी</li><li>लेखापरीक्षित हिशोब आणि अंदाजपत्रक</li><li>व्यवस्थापक समितीची निवड</li><li>अध्यक्षांच्या परवानगीने इतर विषय</li></ol><p>आपली उपस्थिती अपेक्षित आहे.</p>',
      },
    },
  },
  {
    key: 'festival_contribution',
    category: 'FESTIVAL',
    kind: 'STANDARD',
    utilityType: null,
    text: {
      'en-IN': {
        title: '[Festival] celebration and contribution',
        body: '<p>We will celebrate <strong>[festival]</strong> on <strong>[date]</strong> in the society premises.</p><p>A voluntary contribution of <strong>[amount]</strong> per flat is requested. Please pay through the app by <strong>[last date]</strong>.</p>',
      },
      'hi-IN': {
        title: '[त्योहार] उत्सव और योगदान',
        body: '<p>हम <strong>[तारीख]</strong> को सोसायटी परिसर में <strong>[त्योहार]</strong> मनाएंगे।</p><p>प्रति फ्लैट <strong>[राशि]</strong> का स्वैच्छिक योगदान अपेक्षित है। कृपया <strong>[अंतिम तारीख]</strong> तक ऐप से भुगतान करें।</p>',
      },
      'mr-IN': {
        title: '[सण] उत्सव आणि वर्गणी',
        body: '<p>आपण <strong>[तारीख]</strong> रोजी सोसायटी आवारात <strong>[सण]</strong> साजरा करणार आहोत.</p><p>प्रत्येक फ्लॅटसाठी <strong>[रक्कम]</strong> ची ऐच्छिक वर्गणी अपेक्षित आहे. कृपया <strong>[शेवटची तारीख]</strong> पर्यंत अॅपमधून भरा.</p>',
      },
    },
  },
  {
    key: 'pest_control',
    category: 'MAINTENANCE',
    kind: 'STANDARD',
    utilityType: null,
    text: {
      'en-IN': {
        title: 'Pest control treatment on [date]',
        body: '<p>Pest control will be carried out in <strong>[area]</strong> on <strong>[date]</strong> between <strong>[start time] and [end time]</strong>.</p><p>Please keep food covered, secure pets and keep children away from treated areas for a few hours.</p>',
      },
      'hi-IN': {
        title: 'कीट नियंत्रण उपचार: [तारीख]',
        body: '<p><strong>[तारीख]</strong> को <strong>[शुरू समय] से [अंतिम समय]</strong> के बीच <strong>[क्षेत्र]</strong> में कीट नियंत्रण किया जाएगा।</p><p>कृपया खाना ढककर रखें, पालतू जानवरों को सुरक्षित रखें और बच्चों को कुछ घंटे उपचारित जगहों से दूर रखें।</p>',
      },
      'mr-IN': {
        title: 'कीटक नियंत्रण उपचार: [तारीख]',
        body: '<p><strong>[तारीख]</strong> रोजी <strong>[सुरू वेळ] ते [शेवटची वेळ]</strong> दरम्यान <strong>[भाग]</strong> मध्ये कीटक नियंत्रण केले जाईल.</p><p>कृपया अन्न झाकून ठेवा, पाळीव प्राणी सुरक्षित ठेवा आणि मुलांना काही तास उपचारित जागेपासून दूर ठेवा.</p>',
      },
    },
  },
  {
    key: 'fire_drill',
    category: 'SAFETY',
    kind: 'STANDARD',
    utilityType: null,
    text: {
      'en-IN': {
        title: 'Fire drill on [date] at [time]',
        body: '<p>A fire evacuation drill will be held on <strong>[date]</strong> at <strong>[time]</strong>.</p><p>When the alarm sounds, leave your flat, use the stairs (never the lift) and assemble at <strong>[assembly point]</strong>. This is only a drill.</p>',
      },
      'hi-IN': {
        title: 'अग्नि सुरक्षा अभ्यास: [तारीख], [समय]',
        body: '<p><strong>[तारीख]</strong> को <strong>[समय]</strong> बजे आग से बचाव का अभ्यास होगा।</p><p>अलार्म बजने पर अपना फ्लैट छोड़ें, सीढ़ियों का उपयोग करें (लिफ्ट का नहीं) और <strong>[एकत्र होने का स्थान]</strong> पर इकट्ठा हों। यह केवल अभ्यास है।</p>',
      },
      'mr-IN': {
        title: 'अग्निसुरक्षा सराव: [तारीख], [वेळ]',
        body: '<p><strong>[तारीख]</strong> रोजी <strong>[वेळ]</strong> वाजता आगीपासून बचावाचा सराव होईल.</p><p>अलार्म वाजल्यावर फ्लॅट सोडा, जिन्याचा वापर करा (लिफ्टचा नाही) आणि <strong>[जमण्याचे ठिकाण]</strong> येथे जमा व्हा. हा फक्त सराव आहे.</p>',
      },
    },
  },
  {
    key: 'parking_rules',
    category: 'GENERAL',
    kind: 'STANDARD',
    utilityType: null,
    text: {
      'en-IN': {
        title: 'Parking rules for all residents',
        body: '<p>To keep the premises safe and orderly, please follow these parking rules:</p><ul><li>Park only in your allotted slot.</li><li>Visitor vehicles use the visitor bay and leave within <strong>[hours]</strong> hours.</li><li>Do not block the gate, fire lane or another vehicle.</li></ul><p>Vehicles that break these rules may be fined as per the bye-laws.</p>',
      },
      'hi-IN': {
        title: 'सभी निवासियों के लिए पार्किंग नियम',
        body: '<p>परिसर को सुरक्षित और व्यवस्थित रखने के लिए कृपया इन पार्किंग नियमों का पालन करें:</p><ul><li>केवल अपने आवंटित स्थान पर वाहन खड़ा करें।</li><li>मेहमानों के वाहन आगंतुक स्थान पर <strong>[घंटे]</strong> घंटे के भीतर हटाएं।</li><li>गेट, फायर लेन या दूसरे वाहन को न रोकें।</li></ul><p>नियम तोड़ने पर उपनियमों के अनुसार जुर्माना लग सकता है।</p>',
      },
      'mr-IN': {
        title: 'सर्व रहिवाशांसाठी पार्किंग नियम',
        body: '<p>परिसर सुरक्षित आणि व्यवस्थित ठेवण्यासाठी कृपया हे पार्किंग नियम पाळा:</p><ul><li>फक्त आपल्या नेमून दिलेल्या जागेवर वाहन उभे करा.</li><li>पाहुण्यांची वाहने पाहुण्यांच्या जागेत <strong>[तास]</strong> तासांत काढा.</li><li>गेट, फायर लेन किंवा दुसऱ्या वाहनाला अडवू नका.</li></ul><p>नियम मोडल्यास उपनियमांनुसार दंड होऊ शकतो.</p>',
      },
    },
  },
];

export const NOTICE_TEMPLATE_LIBRARY: NoticeTemplate[] = BASES.flatMap(b =>
  (['en-IN', 'hi-IN', 'mr-IN'] as const).map(locale => ({
    key: b.key,
    locale,
    title: b.text[locale].title,
    body: b.text[locale].body,
    category: b.category,
    kind: b.kind,
    utilityType: b.utilityType,
  })),
);

export function listNoticeTemplates(locale?: string): NoticeTemplate[] {
  return locale ? NOTICE_TEMPLATE_LIBRARY.filter(t => t.locale === locale) : NOTICE_TEMPLATE_LIBRARY;
}
