Name: pkg
Version: 1.0
Release: 1
Summary: Archive source fixture
License: MIT
BuildArch: noarch
AutoReqProv: no

%description
Fixture package for the archive source reader.

%install
mkdir -p %{buildroot}/opt/pkg/dir
cp -p %{_sourcedir}/hello.txt %{buildroot}/opt/pkg/hello.txt
cp -p %{_sourcedir}/nested.txt %{buildroot}/opt/pkg/dir/nested.txt
cp -p %{_sourcedir}/data.bin %{buildroot}/opt/pkg/dir/data.bin
ln %{buildroot}/opt/pkg/hello.txt %{buildroot}/opt/pkg/hard.txt
ln -s hello.txt %{buildroot}/opt/pkg/link.txt

%files
%defattr(-,root,root,-)
/opt/pkg/hello.txt
/opt/pkg/hard.txt
/opt/pkg/link.txt
/opt/pkg/dir/nested.txt
/opt/pkg/dir/data.bin
