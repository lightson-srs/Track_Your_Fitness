# Requirements Document

## Introduction

The Member Attendance feature extends the Track Your Fitness PWA with member classification, ID card generation with QR codes, daily attendance tracking (manual and QR-scanned), and attendance reporting. It adds a "Member type" field to existing member records, enhances search across all screens to filter by type, introduces a dedicated Attendance screen with bulk-entry and QR-scan workflows, and provides a date-range attendance report.

## Glossary

- **Application**: The Track Your Fitness PWA running in the browser
- **Member_Form**: The Add/Edit member form on the Members screen
- **Member_Record**: An IndexedDB record in the 'members' object store containing id, name, mobile, notes, status, memberType, and createdAt
- **Member_Type_Field**: A text input with suggested options (Regular, Coaching, Other) that also accepts free-text entry
- **Search_Input**: Any search text field on the Monthly, Guest/Sessions, or Members screens
- **ID_Card**: A printable card showing member name, mobile, member type, notes, unique ID, and a QR code encoding the member ID
- **QR_Code**: A machine-readable two-dimensional barcode encoding the member's unique ID string
- **Attendance_Screen**: A new screen accessible from the More menu for recording daily attendance
- **Attendance_Record**: An IndexedDB record in the 'attendance' object store with fields: id, memberId, date, status
- **Attendance_Status**: A value of either 'present' or 'absent'
- **QR_Scanner**: A camera-based component that reads QR codes using the html5-qrcode library
- **Outstanding_Balance**: The amount owed by a member calculated via Monthly.calcMemberBalance
- **Attendance_Report**: A report section showing per-member attendance counts and detail for a selected date range

## Requirements

### Requirement 1: Member Type Field on Member Form

**User Story:** As a gym owner, I want to classify members by type (Regular, Coaching, Other, or custom text), so that I can organize and filter members by their training arrangement.

#### Acceptance Criteria

1. THE Member_Form SHALL display a Member_Type_Field between the mobile number field and the notes field
2. THE Member_Type_Field SHALL provide suggested options of "Regular", "Coaching", and "Other" while allowing free-text entry
3. WHEN a new member is added without specifying a member type, THE Application SHALL set the memberType value to "Regular"
4. WHEN the Member_Form is submitted, THE Application SHALL store the memberType value in the Member_Record
5. WHEN the Member_Form is opened for editing an existing member, THE Member_Type_Field SHALL display the current memberType value from the Member_Record

### Requirement 2: Search by Member Type

**User Story:** As a gym owner, I want to search for members by their type across all screens, so that I can quickly find all members of a particular category.

#### Acceptance Criteria

1. WHEN a user types in the Search_Input on the Members screen, THE Application SHALL filter members by matching the search term against both the member name and the memberType field
2. WHEN a user types in the Search_Input on the Monthly screen, THE Application SHALL filter members by matching the search term against both the member name and the memberType field
3. WHEN a user types in the Search_Input on the Guest/Sessions screen, THE Application SHALL filter members by matching the search term against both the member name and the memberType field
4. THE Application SHALL perform search matching in a case-insensitive manner using substring comparison

### Requirement 3: Print Member ID Card

**User Story:** As a gym owner, I want to generate and print an ID card for each member, so that members can carry a card with a QR code for attendance scanning.

#### Acceptance Criteria

1. THE Members screen SHALL display a "Print ID" action button for each member in the member list
2. WHEN the "Print ID" button is activated, THE Application SHALL generate an ID_Card displaying the member name, mobile number, member type, notes, and unique member ID
3. WHEN the ID_Card is generated, THE Application SHALL render a QR_Code that encodes the member's unique ID string
4. THE ID_Card SHALL be formatted for printing using CSS print styles with dimensions suitable for card stock
5. WHEN the user triggers the browser print function from the ID_Card view, THE Application SHALL produce a print-ready layout containing only the ID_Card content

### Requirement 4: Attendance Data Store

**User Story:** As a gym owner, I want attendance records persisted locally, so that attendance data is reliably stored and queryable.

#### Acceptance Criteria

1. THE Application SHALL create an 'attendance' IndexedDB object store with keyPath 'id'
2. THE 'attendance' object store SHALL have indexes on 'memberId', 'date', and a composite index on ['memberId', 'date'] with unique constraint
3. WHEN an Attendance_Record is saved for a memberId and date combination that already exists, THE Application SHALL update the existing record rather than creating a duplicate
4. THE Attendance_Record SHALL contain the fields: id, memberId, date (ISO string YYYY-MM-DD), and status ('present' or 'absent')

### Requirement 5: Attendance Screen and Manual Entry

**User Story:** As a gym owner, I want a dedicated attendance screen where I can select a date and mark members present or absent, so that I can record daily attendance efficiently.

#### Acceptance Criteria

1. THE Application SHALL display an "Attendance" menu item in the More menu that navigates to the Attendance_Screen
2. THE Attendance_Screen SHALL display a date picker defaulting to today's date
3. WHEN a date is selected, THE Attendance_Screen SHALL display all active members with a checkbox next to each name
4. WHEN a member checkbox is checked, THE Application SHALL save an Attendance_Record with status 'present' for that member and the selected date
5. WHEN a member checkbox is unchecked, THE Application SHALL save an Attendance_Record with status 'absent' for that member and the selected date
6. THE Attendance_Screen SHALL display a "Select All" toggle that checks or unchecks all member checkboxes at once
7. WHEN members already have Attendance_Records for the selected date, THE Attendance_Screen SHALL pre-check the checkboxes for members marked 'present'

### Requirement 6: Copy from Yesterday

**User Story:** As a gym owner, I want to quickly pre-fill today's attendance from yesterday's records, so that I save time when attendance is similar day-to-day.

#### Acceptance Criteria

1. THE Attendance_Screen SHALL display a "Copy from yesterday" button
2. WHEN the "Copy from yesterday" button is activated, THE Application SHALL retrieve all Attendance_Records with status 'present' from the previous calendar day relative to the currently selected date
3. WHEN yesterday's records are retrieved, THE Application SHALL check the checkboxes for those members and save corresponding Attendance_Records with status 'present' for the selected date
4. IF no Attendance_Records exist for the previous day, THEN THE Application SHALL display a notification stating "No attendance records found for the previous day"

### Requirement 7: QR Scanner for Attendance

**User Story:** As a gym owner, I want to scan a member's ID card QR code to mark them present, so that check-in is fast and hands-free.

#### Acceptance Criteria

1. THE Attendance_Screen SHALL display a "Scan QR" button
2. WHEN the "Scan QR" button is activated, THE Application SHALL request camera access and open a live camera viewfinder for QR code scanning
3. WHEN the QR_Scanner reads a valid QR code containing a member ID, THE Application SHALL look up the member by that ID in the members object store
4. WHEN the member is found, THE Application SHALL save an Attendance_Record with status 'present' for that member and today's date
5. WHEN the member is successfully marked present via QR scan, THE Application SHALL display a confirmation showing the member name, member type, and their Outstanding_Balance
6. IF the QR code does not match any existing member ID, THEN THE Application SHALL display an error message stating "Member not found"
7. IF camera access is denied by the user, THEN THE Application SHALL display a message stating "Camera access is required for QR scanning"

### Requirement 8: Attendance Report

**User Story:** As a gym owner, I want to view attendance summaries for a date range, so that I can track member regularity and identify irregular attendees.

#### Acceptance Criteria

1. THE Reports screen SHALL include an "Attendance" tab accessible via a tab button
2. THE Attendance report tab SHALL display a start date and end date picker for selecting the reporting range
3. WHEN a date range is selected, THE Application SHALL display a list of all members who have at least one Attendance_Record within that range, along with the count of days each member was marked 'present'
4. THE Attendance report SHALL sort members by attendance count in descending order
5. WHEN a member row is tapped in the Attendance report, THE Application SHALL expand or navigate to show the specific dates that member was marked 'present' within the selected range
6. THE Attendance report SHALL display a search field that filters the report by member name or member type
