import * as A from '../src/attendance.js';
const show = (t, v) => console.log(t.padEnd(46), JSON.stringify(v));

// 1. first-name-only guess gets learned as a permanent fact?
let inv = [{ email: 'akash8@amnex.com' }, { email: 'deep5@amnex.com' }];
let m = A.matchPeople(inv, { Akash: [0, 100, 3] }, {});
show('learn from bare first name "Akash"', A.learnEmailNames(m.rows));

// 2. wrong person: only one "rahul" invited, but a different Rahul joined
inv = [{ email: 'rahul@amnex.com' }];
m = A.matchPeople(inv, { 'Rahul Verma': [0, 100, 3] }, {});
show('rahul@ vs "Rahul Verma" (could be a different Rahul)', A.learnEmailNames(m.rows));

// 3. unnamed / anonymous voices and device names
inv = [{ email: 'unnamed@amnex.com' }, { email: 'conference.room@amnex.com' }];
m = A.matchPeople(inv, { 'Unnamed voice 3': [0, 100, 3], 'Conference Room': [0, 100, 3] }, {});
show('learn from "Unnamed voice 3"/room', A.learnEmailNames(m.rows));

// 4. abbreviated display name stored as the real name
inv = [{ email: 'amal.raj@amnex.com' }];
m = A.matchPeople(inv, { 'Amal R.': [0, 100, 3] }, {});
show('learn from "Amal R."', A.learnEmailNames(m.rows));

// 5. the wrong learned name feeds back into matching
A.setEmailNames({ 'rahul@amnex.com': 'Rahul Verma' });
m = A.matchPeople([{ email: 'rahul@amnex.com' }], { 'Rahul Verma': [0, 100, 3] }, {});
show('learned name label', m.rows[0].name);

// 6. attendee list for a present invitee: row.name is a guess, not what was seen
A.setEmailNames({});
m = A.matchPeople([{ email: 'akash8@amnex.com' }], { 'Akash Behera': [0, 100, 3] }, {});
show('present row name vs seen name', { rowName: m.rows[0].name, seen: m.rows[0].present?.name });

// 7. withAddress on calendar-named person with differing email case
show('withAddress same name/email', A.withAddress({ name: 'A@x.com', email: 'a@x.com' }));
show('pretty of weird locals', ['ravi7', 'j.doe', 'o\'brien', '123', 'a_b-c'].map((e) => A.prettyFromEmail(`${e}@x.com`)));
