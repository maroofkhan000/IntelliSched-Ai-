"""Table definitions for the Python pipeline.

Mirrors backend/src/schema.js: the same sheet names, column keys, keys, required fields and
ranges, so a workbook exported from the app ("Export database") can be fed straight in, and a
workbook written here can be imported back into the app.
"""

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
WEEK = ["Sunday", *DAYS]

# column spec: (key, kind, required, extra) — kind is text | number | select | ref | time
# extra: min/max for numbers, options for selects, (table, key) for refs
TABLES = {
    "Branches": {
        "key": ["BranchCode"],
        "columns": [
            ("Degree", "text", True, {}),
            ("BranchCode", "text", True, {"upper": True}),
            ("BranchName", "text", True, {}),
            ("TotalYears", "number", True, {"min": 1, "max": 6}),
            ("SemestersPerYear", "number", True, {"min": 1, "max": 4}),
        ],
    },
    "Sections": {
        "key": ["SectionID"],
        "columns": [
            ("SectionID", "text", False, {"auto": True}),
            ("BranchCode", "ref", True, {"ref": ("Branches", "BranchCode"), "upper": True}),
            ("Year", "number", False, {"auto": True}),
            ("Semester", "number", True, {"min": 1, "max": 12}),
            ("Section", "text", True, {"upper": True}),
            ("Strength", "number", True, {"min": 1, "max": 300}),
        ],
    },
    "Subjects": {
        "key": ["BranchCode", "SubjectCode"],
        "columns": [
            ("SubjectCode", "text", True, {"upper": True}),
            ("BranchCode", "ref", True, {"ref": ("Branches", "BranchCode"), "upper": True}),
            ("Year", "number", False, {"auto": True}),
            ("Semester", "number", True, {"min": 1, "max": 12}),
            ("SubjectName", "text", True, {}),
            ("Type", "select", True, {"options": ["Theory", "Lab"]}),
            ("Credits", "number", True, {"min": 0, "max": 10}),
            ("WeeklyHours", "number", True, {"min": 1, "max": 12}),
        ],
    },
    "Teachers": {
        "key": ["TeacherID"],
        "columns": [
            ("TeacherID", "text", True, {"upper": True}),
            ("TeacherType", "select", False, {"options": ["Theory", "Lab"]}),
            ("Name", "text", True, {}),
            ("BranchCode", "ref", True, {"ref": ("Branches", "BranchCode"), "upper": True}),
            ("Designation", "select", True, {"options": ["Professor", "Associate Professor", "Assistant Professor", "Lecturer", "Visiting Faculty"]}),
            ("MaxWeeklyLoad", "number", True, {"min": 1, "max": 40}),
            ("HomeBuilding", "ref", False, {"ref": ("Buildings", "BuildingCode"), "upper": True}),
            ("MaxBuildingChanges", "number", False, {"min": 0, "max": 10}),
            ("ExtraTravelMinutes", "number", False, {"min": 0, "max": 60}),
        ],
    },
    "TeacherPreferences": {
        "key": ["TeacherID", "SubjectCode"],
        "columns": [
            ("TeacherID", "ref", True, {"ref": ("Teachers", "TeacherID"), "upper": True}),
            ("SubjectCode", "ref", True, {"ref": ("Subjects", "SubjectCode"), "upper": True}),
            ("Priority", "number", True, {"min": 1, "max": 5}),
            ("ExperienceYears", "number", False, {"min": 0, "max": 60}),
            ("TimesTaught", "number", False, {"min": 0, "max": 100}),
            ("ResearchPapers", "number", False, {"min": 0, "max": 1000}),
            ("Remarks", "text", False, {}),
        ],
    },
    "TeacherAvailability": {
        "key": ["TeacherID", "Day", "Period"],
        "columns": [
            ("TeacherID", "ref", True, {"ref": ("Teachers", "TeacherID"), "upper": True}),
            ("Day", "select", True, {"options": WEEK}),
            ("Period", "number", False, {"min": 1, "max": 12}),
            ("Reason", "select", False, {"options": ["Leave", "Admin duty", "Exam duty", "Other campus", "Other"]}),
        ],
    },
    "TeacherSubjectMap": {
        "key": ["TeacherID", "SubjectCode", "SectionID"],
        "columns": [
            ("TeacherID", "ref", True, {"ref": ("Teachers", "TeacherID"), "upper": True}),
            ("SubjectCode", "ref", True, {"ref": ("Subjects", "SubjectCode"), "upper": True}),
            ("SectionID", "ref", True, {"ref": ("Sections", "SectionID"), "upper": True}),
            ("BranchCode", "text", False, {"auto": True}),
            ("Year", "number", False, {"auto": True}),
            ("Semester", "number", False, {"auto": True}),
            ("Section", "text", False, {"auto": True}),
        ],
    },
    "Buildings": {
        "key": ["BuildingCode"],
        "columns": [
            ("BuildingCode", "text", True, {"upper": True}),
            ("BuildingName", "text", True, {}),
            ("Campus", "text", False, {}),
            ("HasLift", "select", False, {"options": ["Yes", "No"]}),
        ],
    },
    "BuildingTravel": {
        "key": ["FromBuilding", "ToBuilding"],
        "columns": [
            ("FromBuilding", "ref", True, {"ref": ("Buildings", "BuildingCode"), "upper": True}),
            ("ToBuilding", "ref", True, {"ref": ("Buildings", "BuildingCode"), "upper": True}),
            ("WalkMinutes", "number", True, {"min": 0, "max": 120}),
        ],
    },
    "Rooms": {
        "key": ["RoomID"],
        "columns": [
            ("RoomID", "text", True, {"upper": True}),
            ("RoomType", "select", True, {"options": ["Classroom", "Lab"]}),
            ("Capacity", "number", True, {"min": 1, "max": 500}),
            ("Building", "text", True, {"upper": True}),
            ("Floor", "number", False, {"min": 0, "max": 9}),
            ("RoomNo", "number", False, {"min": 1, "max": 99}),
        ],
    },
    "TimeSlots": {
        "key": ["Day", "Period"],
        "columns": [
            ("Day", "select", True, {"options": WEEK}),
            ("Period", "number", True, {"min": 1, "max": 12}),
            ("StartTime", "time", True, {}),
            ("EndTime", "time", True, {}),
        ],
    },
}

TABLE_ORDER = list(TABLES)


def columns(table):
    return [c[0] for c in TABLES[table]["columns"]]


def year_of(semester):
    return (int(semester) + 1) // 2


def section_id(branch, semester, section):
    return f"{branch}-Y{year_of(semester)}S{int(semester)}-{section}"
