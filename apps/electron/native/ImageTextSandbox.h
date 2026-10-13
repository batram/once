// Windows OCR runs in a capability-free AppContainer and a bounded, kill-on-close job.
// The broker never parses pixels. It grants read/execute access only to a temporary
// copy of this helper, passes three pipe handles, and waits for the worker.
#pragma once
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <source_location>

namespace image_text_sandbox {
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
inline void require(bool ok, const std::source_location where = std::source_location::current()) {
  if (!ok) throw std::runtime_error("OCR sandbox failed at " + std::to_string(where.line()) + " (Windows " + std::to_string(GetLastError()) + ")");
}

inline bool contained() {
  Handle token;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != 0);
  DWORD value = 0, size = 0;
  require(GetTokenInformation(token.value, TokenIsAppContainer, &value, sizeof value, &size) != 0);
  return value != 0;
}

inline int run(const wchar_t* supplied_directory = nullptr) {
  Handle broker_token;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &broker_token.value) != 0);
  DWORD user_size = 0;
  GetTokenInformation(broker_token.value, TokenUser, nullptr, 0, &user_size);
  std::vector<unsigned char> user_buffer(user_size);
  require(GetTokenInformation(broker_token.value, TokenUser, user_buffer.data(), user_size, &user_size) != 0);
  LPWSTR user_text = nullptr;
  require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user_buffer.data())->User.Sid, &user_text) != 0);
  const std::wstring broker_sid(user_text);
  LocalFree(user_text);
  PSID sid = nullptr;
  const HRESULT created = CreateAppContainerProfile(L"Once.ImageText.NoCapabilities", L"Once image text", L"Local text recognition without capabilities", nullptr, 0, &sid);
  if (created == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) require(SUCCEEDED(DeriveAppContainerSidFromAppContainerName(L"Once.ImageText.NoCapabilities", &sid)));
  else require(SUCCEEDED(created));
  struct SidGuard { PSID value; ~SidGuard() { FreeSid(value); } } sid_guard{sid};
  LPWSTR sid_text = nullptr;
  require(ConvertSidToStringSidW(sid, &sid_text) != 0);
  const std::wstring acl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + broker_sid + L")(A;OICI;GRGX;;;" + std::wstring(sid_text) + L")";
  LocalFree(sid_text);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != 0);
  struct DescriptorGuard { PSECURITY_DESCRIPTOR value; ~DescriptorGuard() { LocalFree(value); } } descriptor_guard{descriptor};
  SECURITY_ATTRIBUTES security{sizeof security, descriptor, FALSE};
  wchar_t temporary[MAX_PATH], unique[MAX_PATH], original[32768];
  std::wstring directory;
  if (supplied_directory) {
    directory = supplied_directory;
    require(SetFileSecurityW(directory.c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor) != 0);
  } else {
    require(GetTempPathW(MAX_PATH, temporary) != 0);
    require(GetTempFileNameW(temporary, L"ocr", 0, unique) != 0);
    require(DeleteFileW(unique) != 0);
    require(CreateDirectoryW(unique, &security) != 0);
    directory = unique;
  }
  const std::wstring executable = directory + L"\\once-image-text.exe";
  struct FilesGuard {
    std::wstring directory, file;
    ~FilesGuard() { DeleteFileW(file.c_str()); RemoveDirectoryW(directory.c_str()); }
  } files{directory, executable};
  const DWORD path_size = GetModuleFileNameW(nullptr, original, 32768);
  require(path_size > 0 && path_size < 32768);
  require(CopyFileW(original, executable.c_str(), TRUE) != 0);
  require(SetFileSecurityW(executable.c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor) != 0);

  Handle job;
  job.value = CreateJobObjectW(nullptr, nullptr);
  require(job.value != nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
    JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_PROCESS_TIME;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  limits.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart = 20LL * 10'000'000;
  limits.ProcessMemoryLimit = 512ULL * 1024 * 1024;
  require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof limits) != 0);

  Handle input, output, errors;
  const auto duplicate = [](DWORD standard, Handle& result) {
    require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(standard), GetCurrentProcess(), &result.value, 0, TRUE, DUPLICATE_SAME_ACCESS) != 0);
  };
  duplicate(STD_INPUT_HANDLE, input); duplicate(STD_OUTPUT_HANDLE, output); duplicate(STD_ERROR_HANDLE, errors);
  HANDLE inherited[] = {input.value, output.value, errors.value};
  SIZE_T length = 0;
  InitializeProcThreadAttributeList(nullptr, 3, 0, &length);
  std::vector<unsigned char> storage(length);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  require(InitializeProcThreadAttributeList(attributes, 3, 0, &length) != 0);
  struct AttributesGuard { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributesGuard() { DeleteProcThreadAttributeList(value); } } attributes_guard{attributes};
  SECURITY_CAPABILITIES capabilities{sid, nullptr, 0, 0};
  DWORD child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
  require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof capabilities, nullptr, nullptr) != 0);
  require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof inherited, nullptr, nullptr) != 0);
  require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &child_policy, sizeof child_policy, nullptr, nullptr) != 0);
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof startup;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.value;
  startup.StartupInfo.hStdOutput = output.value;
  startup.StartupInfo.hStdError = errors.value;
  startup.lpAttributeList = attributes;
  wchar_t windows[MAX_PATH];
  require(GetWindowsDirectoryW(windows, MAX_PATH) != 0);
  // CreateProcess needs the profile locations to initialize an AppContainer.
  // Do not forward API keys or the rest of the parent's environment.
  std::wstring environment;
  for (const wchar_t* name : {L"APPDATA", L"LOCALAPPDATA", L"SystemRoot", L"TEMP", L"TMP", L"USERPROFILE", L"WINDIR"}) {
    wchar_t value[32768];
    const DWORD size = GetEnvironmentVariableW(name, value, 32768);
    if (size && size < 32768) { environment += name; environment += L"="; environment += value; environment.push_back(0); }
  }
  environment.push_back(0);
  PROCESS_INFORMATION process{};
  require(CreateProcessW(executable.c_str(), nullptr, nullptr, nullptr, TRUE,
    EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
    environment.data(), windows, &startup.StartupInfo, &process) != 0);
  Handle worker{process.hProcess}, thread{process.hThread};
  if (!AssignProcessToJobObject(job.value, worker.value)) { TerminateProcess(worker.value, 1); throw std::runtime_error("OCR job failed"); }
  if (ResumeThread(thread.value) == DWORD(-1)) { TerminateJobObject(job.value, 1); throw std::runtime_error("OCR worker could not start"); }
  if (WaitForSingleObject(worker.value, 20'000) != WAIT_OBJECT_0) {
    TerminateJobObject(job.value, 1);
    WaitForSingleObject(worker.value, 5'000);
    throw std::runtime_error("OCR timed out");
  }
  DWORD code = 1;
  require(GetExitCodeProcess(worker.value, &code) != 0);
  return static_cast<int>(code);
}
}
