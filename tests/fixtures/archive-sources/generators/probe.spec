Name: probe
Version: 1.0
Release: 1
Summary: Archive source probe
License: MIT
BuildArch: noarch
AutoReqProv: no

%description
Fixture package for the archive listing whitelist.

%install
mkdir -p %{buildroot}/opt/probe/dir
cp %{_sourcedir}/hello.txt %{buildroot}/opt/probe/hello.txt
cp %{_sourcedir}/nested.txt %{buildroot}/opt/probe/dir/nested.txt
cp %{_sourcedir}/data.bin %{buildroot}/opt/probe/dir/data.bin

%files
%defattr(-,root,root,-)
/opt/probe/hello.txt
/opt/probe/dir/nested.txt
/opt/probe/dir/data.bin
